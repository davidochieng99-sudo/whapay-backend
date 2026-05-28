const express = require("express");
const cors = require("cors");
require("dotenv").config();
const QRCode = require("qrcode");
const admin = require("firebase-admin");
const axios = require("axios");
const { MessagingResponse, VoiceResponse } = require('twilio').twiml;

const { readFileSync, existsSync } = require('fs');

let serviceAccount;
// Option 1: Use environment variable (preferred for Render)
if (process.env.FIREBASE_ADMIN_SDK_KEY) {
  serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SDK_KEY);
  console.log("Firebase: using environment variable FIREBASE_ADMIN_SDK_KEY");
}
// Option 2: Use Render secret file path
else if (existsSync('/etc/secrets/firebase-key.json')) {
  serviceAccount = JSON.parse(readFileSync('/etc/secrets/firebase-key.json', 'utf8'));
  console.log("Firebase: using Render secret file");
}
// Option 3: Local file for development (only if your local file exists)
else if (existsSync('./firebase-key.json')) {
  serviceAccount = require('./firebase-key.json');
  console.log("Firebase: using local firebase-key.json");
}
else {
  throw new Error("No Firebase credentials found. Set FIREBASE_ADMIN_SDK_KEY env var or add secret file.");
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
console.log("✅ Firebase connected successfully");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static("public"));

// Force HTTPS redirect (fixes Google indexing)
app.use((req, res, next) => {
  // Only redirect in production (not on localhost)
  if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});
// Test route – remove later
app.get("/ping", (req, res) => {
  res.send("pong");
});
// Simple in-memory rate limiter (resets on server restart)
const rateLimitStore = new Map();

function rateLimiter(req, res, next) {
  // Only apply to POST payment endpoints
  if (req.path === '/api/pay-offline' && req.method === 'POST') {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute
    const maxRequests = 5;

    if (!rateLimitStore.has(ip)) {
      rateLimitStore.set(ip, [now]);
      next();
      return;
    }

    const timestamps = rateLimitStore.get(ip);
    // Remove timestamps older than windowMs
    const recent = timestamps.filter(t => now - t < windowMs);
    
    if (recent.length >= maxRequests) {
      res.status(429).json({
        success: false,
        error: "Too many requests. Please try again later."
      });
      return;
    }

    recent.push(now);
    rateLimitStore.set(ip, recent);
  }
  next();
}

// Apply the rate limiter globally (or specifically to your route)
app.use(rateLimiter);

// Simple idempotency store (in memory, resets on restart)
const idempotencyStore = new Map();

app.use((req, res, next) => {
  // Only apply to payment endpoints
  if (req.path === '/api/pay-offline' && req.method === 'POST') {
    // Create a unique key from the request body
    const { merchantCode, customerPhone, amount, description } = req.body;
    const key = `${merchantCode}_${customerPhone}_${amount}_${description || ''}`;
    
    // Check if already processed
    if (idempotencyStore.has(key)) {
      console.log(`⛔ Duplicate payment blocked: ${key}`);
      return res.json({ success: false, error: "Duplicate payment request ignored." });
    }
    
    // Store it and continue
    idempotencyStore.set(key, Date.now());
    // Optional: clean up old keys after 24 hours
    setTimeout(() => idempotencyStore.delete(key), 24 * 60 * 60 * 1000);
    
    req.idempotencyKey = key; // attach for logging
  }
  next();
});

// Sync offline pending items (from frontend localforage)
app.post("/api/sync", async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ success: false, error: "Missing items array" });
    }

    const results = [];
    for (const item of items) {
      // Skip if already marked synced (frontend should only send unsynced)
      if (item.synced) continue;

      // Generate idempotency key to avoid duplicate processing
      const syncKey = `sync_${item.type}_${item.createdAt || Date.now()}_${item.phone || item.customerPhone}`;
      if (idempotencyStore.has(syncKey)) {
        results.push({ key: syncKey, status: "skipped", reason: "duplicate" });
        continue;
      }
      idempotencyStore.set(syncKey, Date.now());

      if (item.type === "payment" || item.type === "member_code") {
        await db.collection("transactions").add({
          customer: item.name,
          customerPhone: item.customerPhone || item.phone,
          amount: item.amount,
          method: item.method,
          status: "completed",
          merchantCode: item.merchantCode,
          description: item.description,
          syncedAt: new Date().toISOString(),
          createdAt: new Date(item.createdAt || Date.now())
        });
        results.push({ key: syncKey, status: "success", type: "payment" });
      }
      else if (item.type === "registration") {
        // Create user (optional: store memberCode)
        const dkCode = await getNextDkCode();
        const qrData = `https://whapay-backend.onrender.com/pay?code=${dkCode}`;
        const qrImage = await generateQRCode(qrData);
        await db.collection("users").add({
          fullName: item.name,
          phone: item.phone,
          memberCode: dkCode,
          qrCodeUrl: qrImage,
          userType: "customer",
          status: "active",
          createdAt: new Date(item.createdAt || Date.now())
        });
        if (item.amount) {
          await db.collection("transactions").add({
            customer: item.name,
            customerPhone: item.phone,
            amount: item.amount,
            method: item.method,
            status: "completed",
            syncedAt: new Date().toISOString(),
            createdAt: new Date(item.createdAt || Date.now())
          });
        }
        results.push({ key: syncKey, status: "success", type: "registration" });
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error("Sync error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// Get live stats from Firestore
app.get("/api/stats", async (req, res) => {
  try {
    // Count merchants (users with userType "merchant")
    const merchantsSnapshot = await db.collection("users").where("userType", "==", "merchant").get();
    const totalMerchants = merchantsSnapshot.size;

    // Count all transactions
    const transactionsSnapshot = await db.collection("transactions").get();
    const totalTransactions = transactionsSnapshot.size;

    // Sum completed transaction amounts
    let totalVolume = 0;
    transactionsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.status === "completed" || data.status === "success") {
        totalVolume += (data.amount || 0);
      }
    });

    res.json({
      success: true,
      totalMerchants,
      totalTransactions,
      totalVolume
    });
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper: generate next DK code (DK0001, DK0002, ...)
async function getNextDkCode() {
  const counterRef = db.collection("counters").doc("dkCounter");
  const doc = await counterRef.get();
  let nextNumber;
  if (!doc.exists) {
    await counterRef.set({ value: 1 });
    nextNumber = 1;
  } else {
    nextNumber = doc.data().value;
    await counterRef.update({ value: nextNumber + 1 });
  }
  return "DK" + String(nextNumber).padStart(4, "0");
}

// Helper: generate QR code as data URL
async function generateQRCode(data) {
  try {
    return await QRCode.toDataURL(data);
  } catch (err) {
    console.error("QR error:", err);
    return null;
  }
}



// ========== WHATSAPP BUSINESS OS (STOREFRONT) ==========

// Add/Update product
app.post("/api/merchant/product", async (req, res) => {
  try {
    const { merchantCode, name, price, description, imageUrl } = req.body;
    if (!merchantCode || !name || !price) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    
    const merchants = await db.collection("users").where("dkCode", "==", merchantCode).get();
    if (merchants.empty) return res.status(404).json({ error: "Merchant not found" });
    
    const product = {
      merchantCode,
      name,
      price: parseFloat(price),
      description: description || "",
      imageUrl: imageUrl || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    const docRef = await db.collection("products").add(product);
    res.json({ success: true, productId: docRef.id, product });
  } catch (error) {
    console.error("Add product error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/directory/merchants", async (req, res) => {
    try {
        const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000);
        const snapshot = await db.collection("directory_listings")
            .where("status", "==", "active")
            .where("lastTransaction", ">=", thirtyDaysAgo)
            .get();
        const merchants = [];
        snapshot.forEach(doc => merchants.push({ id: doc.id, ...doc.data() }));
        res.json({ success: true, merchants });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get("/directory/merchant/:code", async (req, res) => {
    const { code } = req.params;
    try {
        const merchantDoc = await db.collection("directory_listings")
            .where("merchantCode", "==", code)
            .where("status", "==", "active")
            .limit(1)
            .get();
        if (merchantDoc.empty) return res.status(404).send("Merchant not found");
        const m = merchantDoc.docs[0].data();
        res.send(`<!DOCTYPE html>
        <html>
        <head><title>${m.businessName} - Pay with M-Pesa or Card | WhaPay</title>
        <meta name="description" content="Pay ${m.businessName} using M-Pesa, Visa, or Mastercard. Member Code: ${code}. Located in ${m.locationName}.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="https://cdn.tailwindcss.com">
        </head>
        <body class="bg-gray-100">
        <div class="max-w-2xl mx-auto p-6">
            <div class="bg-white rounded-2xl shadow-lg p-6">
                <h1 class="text-2xl font-bold">${m.businessName}</h1>
                <p class="text-gray-600">📍 ${m.locationName} ${m.area ? `- ${m.area}` : ''}</p>
                <div class="mt-2"><span class="bg-green-100 text-green-700 px-2 py-1 rounded-full text-sm">${m.categoryName || m.category}</span></div>
                <p class="mt-3">${m.description || ''}</p>
                <div class="mt-4 p-3 bg-gray-50 rounded-lg">
                    <strong>Member Code:</strong> ${code}<br>
                    <button onclick="navigator.clipboard.writeText('${code}')" class="mt-1 bg-gray-200 px-3 py-1 rounded text-sm">Copy Code</button>
                </div>
                <a href="/payment.html?merchant=${code}" class="mt-4 inline-block bg-green-600 text-white px-5 py-2 rounded-full">💳 Pay Now</a>
                <p class="text-xs text-gray-400 mt-4">Powered by WhaPay – Accepts M-Pesa, Cards, Airtel, MTN, Tigo, Orange</p>
            </div>
        </div>
        </body>
        </html>`);
    } catch(e) {
        res.status(500).send("Error");
    }
});

// ========== MERCHANT DIRECTORY VERIFY ==========
app.post("/api/directory/verify", async (req, res) => {
    try {
        const { merchantCode } = req.body;
        if (!merchantCode) return res.status(400).json({ success: false, error: "Member Code required" });

        // Find merchant in users collection
        const userQuery = await db.collection("users").where("dkCode", "==", merchantCode).get();
        if (userQuery.empty) return res.status(404).json({ success: false, error: "Member Code not found" });
        const merchantData = userQuery.docs[0].data();

        // Check last PAID transaction (method NOT 'mpesa') AND status 'completed' within 30 days
        const lastTxQuery = await db.collection("transactions")
            .where("merchantCode", "==", merchantCode)
            .where("method", "!=", "mpesa")
            .where("status", "==", "completed")
            .orderBy("createdAt", "desc")
            .limit(1)
            .get();

        let isActive = false;
        let lastTransactionDate = null;
        let lastMethod = null;

        if (!lastTxQuery.empty) {
            const lastTx = lastTxQuery.docs[0].data();
            lastTransactionDate = lastTx.createdAt;
            lastMethod = lastTx.method;
            const daysSince = (Date.now() - new Date(lastTx.createdAt).getTime()) / (1000*60*60*24);
            if (daysSince <= 30) isActive = true;
        }

        if (!isActive) {
            return res.status(403).json({
                success: false,
                error: "You need at least one successful PAID transaction (card, Airtel, MTN, Tigo, Orange, or Bank Transfer) in the last 30 days to claim a directory listing. M-Pesa payments do not count."
            });
        }

        // Check if already has a directory listing
        const existingListing = await db.collection("directory_listings")
            .where("merchantCode", "==", merchantCode)
            .limit(1)
            .get();

        res.json({
            success: true,
            verified: true,
            merchant: {
                businessName: merchantData.fullname || "",
                phone: merchantData.phoneNumber || "",
                merchantCode: merchantCode,
                lastTransaction: lastTransactionDate,
                lastMethod: lastMethod
            },
            existingListing: existingListing.empty ? null : existingListing.docs[0].data()
        });
    } catch (error) {
        console.error("Verify error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// ========================
// Paystack Webhook
// ========================
app.post('/api/paystack-webhook', async (req, res) => {
  const event = req.body;
  const PAYSTACK_SECRET = 'sk_test_dd7bfc8ccdae3b7eda8e0dba3ad37335';

  if (event.event === 'charge.success') {
    const reference = event.data.reference;
    const transactionId = event.data.metadata?.transactionId;
    const amount = event.data.amount / 100;

    console.log(`✅ Paystack payment successful: ${reference}`);

    if (transactionId) {
      const transactions = await db.collection("transactions")
        .where("transactionId", "==", transactionId)
        .get();

      if (!transactions.empty) {
        const transaction = transactions.docs[0];
        await transaction.ref.update({
          status: "completed",
          paystackReference: reference,
          completedAt: new Date().toISOString()
        });
        console.log(`✅ Transaction ${transactionId} updated`);

        const data = transaction.data();
        if (data.customerPhone) {
          await sendSMS(data.customerPhone, `✅ Payment of KES ${amount} successful!`);
        }
      }
    }
  }

  res.sendStatus(200);
});

// ========================
// Paystack Payment Initialization (Kenya)
// ========================
const PAYSTACK_SECRET = 'sk_test_dd7bfc8ccdae3b7eda8e0dba3ad37335';

app.post("/api/paystack/initialize", async (req, res) => {
  try {
    const { email, amount, metadata, callback_url } = req.body;
    
    if (!paystackSecret) {
      return res.status(500).json({ error: "Paystack secret key not set" });
    }
    
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: email,
        amount: amount * 100, // Paystack uses kobo
        currency: "KES",
        metadata: metadata,
        callback_url: callback_url || "https://whapay.space/payment-callback"
      },
      {
        headers: {
          Authorization: `Bearer ${paystackSecret}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    if (!response.data.status) {
      throw new Error(response.data.message);
    }
    
    res.json({
      success: true,
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference
    });
  } catch (error) {
    console.error("Paystack error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ========== MERCHANT DIRECTORY SAVE ==========
app.post("/api/directory/save", async (req, res) => {
    try {
        const { merchantCode, businessName, category, categoryName, location, locationName, area, description, phone, image, premium, priceRange, website, hours } = req.body;

        if (!merchantCode || !businessName) {
            return res.status(400).json({ success: false, error: "Missing required fields" });
        }

        // Re-verify the merchant (must have a recent paid transaction)
        const lastTxQuery = await db.collection("transactions")
            .where("merchantCode", "==", merchantCode)
            .where("method", "!=", "mpesa")
            .where("status", "==", "completed")
            .orderBy("createdAt", "desc")
            .limit(1)
            .get();

        if (lastTxQuery.empty) {
            return res.status(403).json({ success: false, error: "No PAID transaction found. M-Pesa payments do not qualify." });
        }

        const lastTx = lastTxQuery.docs[0].data();
        const daysSince = (Date.now() - new Date(lastTx.createdAt).getTime()) / (1000*60*60*24);
        if (daysSince > 30) {
            return res.status(403).json({ success: false, error: "Last paid transaction is older than 30 days. Make a new paid payment to keep listing active." });
        }

        // Prepare document
        const listingData = {
            merchantCode,
            businessName,
            category,
            categoryName: categoryName || "",
            location,
            locationName: locationName || "",
            area: area || "",
            description: description || "",
            phone: phone || "",
            image: image || "🏪",
            premium: premium === true || premium === "true",
            priceRange: priceRange || "KES 100 - 5000",
            website: website || "",
            hours: hours || "",
            status: "active",
            lastTransaction: lastTx.createdAt,
            lastMethod: lastTx.method,
            updatedAt: new Date().toISOString()
        };

        // Upsert (update if exists, else create)
        const existing = await db.collection("directory_listings").where("merchantCode", "==", merchantCode).get();
        if (existing.empty) {
            await db.collection("directory_listings").add(listingData);
        } else {
            await existing.docs[0].ref.update(listingData);
        }

        res.json({ success: true, message: "Directory listing saved! It will appear on WhaPay within minutes." });
    } catch (error) {
        console.error("Save directory error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});



// Get merchant's products
app.get("/api/merchant/products", async (req, res) => {
  try {
    const { merchantCode } = req.query;
    const products = await db.collection("products").where("merchantCode", "==", merchantCode).get();
    res.json(products.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete product
app.delete("/api/merchant/product", async (req, res) => {
  try {
    const { productId } = req.body;
    await db.collection("products").doc(productId).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// WhatsApp webhook for storefront (Dexatel)
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const customerPhone = req.body.from?.replace(/\D/g, '') || '';
    const merchantPhone = req.body.to?.replace(/\D/g, '') || '';
    const message = req.body.text?.toLowerCase().trim() || '';
    
    // Find merchant by phone
    const merchants = await db.collection("users").where("phoneNumber", "==", merchantPhone).get();
    if (merchants.empty) {
      await sendWhatsAppMessage(customerPhone, "This number is not registered as a WhaPay merchant.");
      return res.sendStatus(200);
    }
    const merchant = merchants.docs[0];
    const merchantCode = merchant.data().dkCode;
    
    // Get merchant's products
    const products = await db.collection("products").where("merchantCode", "==", merchantCode).get();
    
    // Handle "STORE" command
    if (message === 'store') {
      if (products.empty) {
        await sendWhatsAppMessage(customerPhone, "This merchant has no products yet. Check back later!");
        return res.sendStatus(200);
      }
      
      let storeMessage = "🛍️ *STORE*\n\n";
      let idx = 1;
      for (const doc of products.docs) {
        const p = doc.data();
        storeMessage += `${idx}. *${p.name}* – KES ${p.price}\n   ${p.description || ''}\n\n`;
        idx++;
      }
      storeMessage += "Reply with the number to order.";
      await sendWhatsAppMessage(customerPhone, storeMessage);
      return res.sendStatus(200);
    }
    
    // Handle product selection (number)
    const productNumber = parseInt(message);
    if (!isNaN(productNumber) && productNumber >= 1 && productNumber <= products.size) {
      const product = products.docs[productNumber - 1].data();
      await db.collection("cart_sessions").doc(customerPhone).set({
        merchantCode,
        productId: products.docs[productNumber - 1].id,
        productName: product.name,
        productPrice: product.price,
        step: 'awaiting_quantity',
        createdAt: new Date().toISOString()
      });
      await sendWhatsAppMessage(customerPhone, `🛒 *${product.name}* – KES ${product.price}\n\nReply with the quantity (e.g., "2") to proceed.`);
      return res.sendStatus(200);
    }
    
    // Handle quantity
    const quantity = parseInt(message);
    const session = await db.collection("cart_sessions").doc(customerPhone).get();
    if (session.exists && session.data().step === 'awaiting_quantity' && !isNaN(quantity)) {
      const productPrice = session.data().productPrice;
      const total = productPrice * quantity;
      const paymentLink = `https://whapay.space/pay.html?merchant=${session.data().merchantCode}&amount=${total}&product=${encodeURIComponent(session.data().productName)}&quantity=${quantity}`;
      await sendWhatsAppMessage(customerPhone, `✅ Total: KES ${total}\nClick here to complete payment: ${paymentLink}`);
      await db.collection("cart_sessions").doc(customerPhone).delete();
      return res.sendStatus(200);
    }
    
    // Default response
    await sendWhatsAppMessage(customerPhone, "💬 Send 'STORE' to see available products.");
    res.sendStatus(200);
  } catch (error) {
    console.error("WhatsApp webhook error:", error);
    res.sendStatus(500);
  }
});

// Enable/disable storefront for merchant
app.post("/api/merchant/storefront", async (req, res) => {
  try {
    const { merchantCode, enabled } = req.body;
    const merchants = await db.collection("users").where("dkCode", "==", merchantCode).get();
    if (merchants.empty) return res.status(404).json({ error: "Merchant not found" });
    await merchants.docs[0].ref.update({ storefrontEnabled: enabled });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// Helper: send WhatsApp message (opens link)
async function sendWhatsAppMessage(phoneNumber, message) {
  const normalizedPhone = phoneNumber.replace(/^0+/, "254");
  const link = `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(message)}`;
  return { success: true, link };
}

// ========================
// Send SMS via Twilio (used for receipts)
// ========================
async function sendSMS(phoneNumber, message) {
  try {
    const response = await twilioClient.messages.create({
      body: message,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER
    });
    console.log(`✅ SMS sent to ${phoneNumber}`);
    return { success: true, sid: response.sid };
  } catch (error) {
    console.error(`❌ SMS failed to ${phoneNumber}:`, error.message);
    return { success: false, error: error.message };
  }
}
// Register or get user by phone
async function registerOrGetUser(phoneNumber, fullname = null, userType = "customer") {
  let normalizedPhone = phoneNumber.replace(/^0+/, "254");
  const usersRef = db.collection("users");
  const existing = await usersRef.where("phoneNumber", "==", normalizedPhone).get();
  if (!existing.empty) {
    const doc = existing.docs[0];
    return {
      id: doc.id,
      dkCode: doc.data().dkCode,
      qrCodeUrl: doc.data().qrCodeUrl,
      fullname: doc.data().fullname,
      phoneNumber: doc.data().phoneNumber,
      userType: doc.data().userType,
      isNew: false,
    };
  }
  const dkCode = await getNextDkCode();
  const qrData = `https://whapay-backend.onrender.com/pay?code=${dkCode}`;
  const qrImage = await generateQRCode(qrData);
  const newUser = {
    phoneNumber: normalizedPhone,
    fullname: fullname || "User",
    dkCode,
    qrCodeUrl: qrImage,
    userType,
    balance: 0,
    createdAt: new Date().toISOString(),
  };
  const docRef = await db.collection("users").add(newUser);
  return {
    id: docRef.id,
    dkCode,
    qrCodeUrl: qrImage,
    fullname: newUser.fullname,
    phoneNumber: normalizedPhone,
    userType,
    isNew: true,
  };
}

// Save transaction
async function saveTransaction(data) {
  const docRef = db.collection("transactions").doc();
  await docRef.set({ ...data, createdAt: new Date().toISOString() });
  return docRef.id;
}

// Send receipts with method-based fees
async function sendConfirmations(paymentData) {
  const { transactionId, merchant, customer, amount, description, status, reason, paymentMethod } = paymentData;
  
  // Fees based on how customer interacted
  let methodFee = 0;
  let methodName = "";
  
  if (paymentMethod === "sms") {
    methodFee = 30;      // Twilio SMS cost (inbound or outbound)
    methodName = "SMS Fee";
  } else if (paymentMethod === "voice") {
    methodFee = 39;      // Twilio voice call cost (per minute)
    methodName = "Voice Call Fee";
  } else if (paymentMethod === "whatsapp") {
    methodFee = 1;       // Meta WhatsApp cost
    methodName = "WhatsApp Fee";
  } else if (paymentMethod === "card" || paymentMethod === "mpesa" || paymentMethod === "mobile_money") {
    methodFee = 0;       // No extra fee for direct payment methods (fees handled separately)
    methodName = "";
  }
  
  // Transaction fee (only if payment is involved)
  let transactionFee = 0;
  let totalPaid = amount;
  
  if (amount > 0) {
    transactionFee = Math.round(amount * 0.03); // 3% transaction fee
    totalPaid = amount + transactionFee + methodFee;
  } else {
    totalPaid = methodFee; // Registration only (no payment)
  }
  
  const serviceFee = 50;   // WhaPay service fee (added to all transactions)
  if (amount > 0) {
    totalPaid = totalPaid + serviceFee;
  }
  
  const now = new Date();
  const dateTime = now.toLocaleString();
  
  // Build breakdown message
  let breakdownText = `Amount: KES ${amount}\n`;
  if (transactionFee > 0) breakdownText += `Transaction Fee (3%): KES ${transactionFee}\n`;
  if (methodFee > 0) breakdownText += `${methodName}: KES ${methodFee}\n`;
  if (amount > 0) breakdownText += `Service Fee: KES ${serviceFee}\n`;
  breakdownText += `━━━━━━━━━━━━━━━━━━━━━\n*TOTAL PAID: KES ${totalPaid}*`;
  
  // Customer receipt
  const customerReceipt = `
🏪 *WHA ${amount > 0 ? "PAYMENT" : "REGISTRATION"} RECEIPT*
━━━━━━━━━━━━━━━━━━━━━
Transaction: ${transactionId}
${amount > 0 ? `Merchant: ${merchant.fullname} (${merchant.dkCode})` : `Customer: ${customer.fullname} (${customer.dkCode})`}
Description: ${description || (amount > 0 ? "Payment" : "Registration")}
━━━━━━━━━━━━━━━━━━━━━
*Breakdown:*
${breakdownText}
━━━━━━━━━━━━━━━━━━━━━
Time: ${dateTime}
Status: ✅ ${status.toUpperCase()}
${reason ? `Reason: ${reason}` : ""}
━━━━━━━━━━━━━━━━━━━━━
Thank you for using WhaPay!`;
  
  // Merchant notification (only if payment)
  let merchantNotification = "";
  if (amount > 0) {
    merchantNotification = `
💰 *PAYMENT RECEIVED*
━━━━━━━━━━━━━━━━━━━━━
Transaction: ${transactionId}
Customer: ${customer.fullname} (${customer.dkCode})
Amount: KES ${amount}
Description: ${description || "Payment"}
Time: ${dateTime}
━━━━━━━━━━━━━━━━━━━━━`;
  }
  
  // Send based on payment method
  if (paymentMethod === "whatsapp") {
    await sendWhatsAppMessage(customer.phoneNumber, customerReceipt);
    if (merchantNotification) await sendWhatsAppMessage(merchant.phoneNumber, merchantNotification);
  } else if (paymentMethod === "sms") {
    await sendSMS(customer.phoneNumber, customerReceipt);
    if (merchantNotification) await sendSMS(merchant.phoneNumber, merchantNotification);
  } else if (paymentMethod === "voice") {
    // For voice, you would use your voice endpoint to read the receipt
    await sendSMS(customer.phoneNumber, customerReceipt); // Fallback to SMS for now
    if (merchantNotification) await sendSMS(merchant.phoneNumber, merchantNotification);
  } else {
    // Card, M-Pesa, etc.
    await sendSMS(customer.phoneNumber, customerReceipt);
    if (merchantNotification) await sendSMS(merchant.phoneNumber, merchantNotification);
  }
  
  return { customerReceipt, merchantNotification };
}
// ---------- HTML pages ----------
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>Whapay</title>
<style>body { font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5; }
.container { max-width: 500px; margin: auto; background: white; padding: 30px; border-radius: 10px; }
h1 { color: #25D366; }
.btn { display: inline-block; padding: 15px 30px; margin: 10px; background: #25D366; color: white; text-decoration: none; border-radius: 5px; }</style>
</head>
<body>
<div class="container">
<h1>💳 Whapay</h1>
<p>Send and receive payments instantly</p>
<a href="/pay" class="btn">💰 Make a Payment</a>
<a href="/merchant" class="btn">🏪 Merchant Dashboard</a>
</div>
</body>
</html>`);
});

// ========== CUSTOMER CARD FEE (Added May 2026) ==========
function calculateCustomerCardFee(amount) {
  if (amount <= 500) return 10;
  if (amount <= 2000) return 20;
  if (amount <= 5000) return 40;
  return Math.min(Math.round(amount * 0.01), 200);
}

// ========== SUBSCRIPTION PLANS ==========
const SUBSCRIPTION_PLANS = {
  free: { name: "Free", price: 0, cardFee: 0.025, cardFeeFixed: 20 },
  basic: { name: "Basic", price: 499, cardFee: 0.015, cardFeeFixed: 20 },
  pro: { name: "Pro", price: 999, cardFee: 0.01, cardFeeFixed: 20 }
};

// Create subscription
app.post("/api/subscription/create", async (req, res) => {
  try {
    const { merchantCode, plan } = req.body;
    if (!SUBSCRIPTION_PLANS[plan]) return res.status(400).json({ error: "Invalid plan" });
    
    const merchants = await db.collection("users").where("dkCode", "==", merchantCode).get();
    if (merchants.empty) return res.status(404).json({ error: "Merchant not found" });
    
    await merchants.docs[0].ref.update({ subscriptionPlan: plan });
    
    const existingSub = await db.collection("subscriptions").where("merchantId", "==", merchants.docs[0].id).get();
    const subscription = {
      merchantCode,
      merchantId: merchants.docs[0].id,
      plan,
      status: "active",
      startDate: new Date().toISOString(),
      nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };
    
    if (!existingSub.empty) {
      await existingSub.docs[0].ref.update(subscription);
    } else {
      await db.collection("subscriptions").add(subscription);
    }
    
    const msg = `✅ WhaPay Subscription: ${SUBSCRIPTION_PLANS[plan].name} plan (KES ${SUBSCRIPTION_PLANS[plan].price}/month). Next billing: ${subscription.nextBillingDate}`;
    await sendWhatsAppMessage(merchants.docs[0].data().phoneNumber, msg);
    
    res.json({ success: true, plan });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get merchant subscription
app.get("/api/subscription/:merchantCode", async (req, res) => {
  try {
    const { merchantCode } = req.params;
    const merchants = await db.collection("users").where("dkCode", "==", merchantCode).get();
    if (merchants.empty) return res.status(404).json({ error: "Merchant not found" });
    
    const plan = merchants.docs[0].data().subscriptionPlan || "free";
    res.json({ success: true, plan, details: SUBSCRIPTION_PLANS[plan] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== RETAIL SELF-PAYMENT (Customer dials their Member Code) ==========
// USSD Handler - Customer dials *014*DK005#
app.post("/api/ussd-member", async (req, res) => {
  try {
    let { sessionId, phoneNumber, text } = req.body;
    let input = text ? text.split("*") : [];
    let level = input.length;
    let memberCode = input[0] ? input[0].toUpperCase() : "";
    let response = "";
    
    if (!memberCode) {
      response = "CON Enter your WhaPay Member Code (e.g., DK005):";
    }
    else if (level === 1) {
      let users = await db.collection("users").where("dkCode", "==", memberCode).get();
      if (users.empty) {
        response = `END Member Code ${memberCode} not found.\n\nRegister: WhatsApp REGISTER to 0140933042`;
      } else {
        await db.collection("ussd_sessions").doc(sessionId).set({
          phoneNumber, memberCode, step: "merchant_input", createdAt: new Date().toISOString()
        });
        response = "CON Enter merchant (Till/Paybill/Name):\nExample: Carrefour or 123456";
      }
    }
    else if (level === 2) {
      let merchantId = input[1];
      await db.collection("ussd_sessions").doc(sessionId).update({ merchantId, step: "amount" });
      response = "CON Enter amount in KES:";
    }
    else if (level === 3) {
      let amount = parseFloat(input[2]);
      let fee = amount <= 1000 ? 10 : (amount <= 5000 ? 20 : (amount <= 20000 ? 50 : 100));
      let total = amount + fee;
      await db.collection("ussd_sessions").doc(sessionId).update({ amount, fee, total, step: "payment_method" });
      response = `CON Amount: KES ${amount}\nFee: KES ${fee}\nTotal: KES ${total}\n\n1. Card\n2. M-Pesa`;
    }
    else if (level === 4) {
      let choice = input[3];
      let session = await db.collection("ussd_sessions").doc(sessionId).get();
      let data = session.data();
      
      if (choice === "1") {
        let paymentLink = `https://whapay.space/pay?amount=${data.amount}&merchant=${encodeURIComponent(data.merchantId)}&fee=${data.fee}&code=${data.memberCode}`;
        await sendWhatsAppMessage(data.phoneNumber, `💳 Pay KES ${data.total}: ${paymentLink}`);
        response = `END Payment link sent via WhatsApp.\nMerchant: ${data.merchantId}\nAmount: KES ${data.amount}\nFee: KES ${data.fee}\nTotal: KES ${data.total}`;
      } else if (choice === "2") {
        await session.ref.update({ step: "mpesa_phone" });
        response = "CON Enter M-Pesa phone number:";
      } else {
        response = "END Invalid. Send 1 for Card or 2 for M-Pesa.";
      }
    }
    else if (level === 5) {
      let mpesaPhone = input[4];
      let session = await db.collection("ussd_sessions").doc(sessionId).get();
      let data = session.data();
      let cleanPhone = mpesaPhone.replace(/\D/g, '');
      if (cleanPhone.startsWith("0")) cleanPhone = "254" + cleanPhone.substring(1);
      
      response = `END STK push sent to ${cleanPhone}.\nAmount: KES ${data.total}\nCheck your phone and enter PIN.`;
      await session.ref.delete();
    }
    
    res.set("Content-Type", "text/plain");
    res.send(response);
  } catch (error) {
    console.error("USSD error:", error);
    res.send("END System error. Try again.");
  }
});


// ========== SAVED CARDS & OFFLINE CARD PAYMENTS ==========

// Save card for a customer (tokenize via Flutterwave)
app.post("/api/card/save", async (req, res) => {
  try {
    const { customerPhone, cardNumber, expiry, cvv } = req.body;
    
    // TODO: After Flutterwave approval, replace with actual tokenization
    // For now, simulate tokenization
    const cardToken = `tok_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const last4 = cardNumber.slice(-4);
    
    // Store tokenized card under customer's phone number
    const customerRef = db.collection("users").where("phoneNumber", "==", customerPhone);
    const customer = await customerRef.get();
    
    if (customer.empty) {
      return res.status(404).json({ error: "Customer not found. Register first." });
    }
    
    const customerId = customer.docs[0].id;
    const savedCards = await db.collection("saved_cards").where("customerId", "==", customerId).get();
    
    // Check if card already exists
    let cardExists = false;
    savedCards.forEach(doc => {
      if (doc.data().last4 === last4) cardExists = true;
    });
    
    if (!cardExists) {
      await db.collection("saved_cards").add({
        customerId,
        customerPhone,
        cardToken,
        last4,
        expiry,
        createdAt: new Date().toISOString()
      });
    }
    
    res.json({ success: true, message: "Card saved successfully", last4 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get saved cards for a customer
app.get("/api/card/saved/:phone", async (req, res) => {
  try {
    const { phone } = req.params;
    const customers = await db.collection("users").where("phoneNumber", "==", phone).get();
    if (customers.empty) {
      return res.json({ savedCards: [] });
    }
    const customerId = customers.docs[0].id;
    const savedCards = await db.collection("saved_cards").where("customerId", "==", customerId).get();
    
    const cards = savedCards.docs.map(doc => ({
      id: doc.id,
      last4: doc.data().last4,
      expiry: doc.data().expiry
    }));
    
    res.json({ success: true, savedCards: cards });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Process offline card payment (store for later sync)
app.post("/api/offline/card-pay", async (req, res) => {
  try {
    const { customerPhone, merchantCode, amount, savedCardId } = req.body;
    
    // Store offline payment in pending collection
    const offlinePayment = {
      customerPhone,
      merchantCode,
      amount,
      savedCardId,
      status: "pending",
      type: "card",
      createdAt: new Date().toISOString(),
      synced: false
    };
    
    await db.collection("offline_payments").add(offlinePayment);
    res.json({ success: true, message: "Offline card payment saved. Will process when online." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sync offline card payments (call when customer comes online)
app.post("/api/offline/card-sync", async (req, res) => {
  try {
    const { customerPhone } = req.body;
    const pending = await db.collection("offline_payments")
      .where("customerPhone", "==", customerPhone)
      .where("synced", "==", false)
      .get();
    
    let synced = 0;
    for (const doc of pending.docs) {
      const payment = doc.data();
      // TODO: After Flutterwave approval, process actual charge using saved card token
      console.log(`Processing offline card payment: ${payment.amount} to ${payment.merchantCode}`);
      
      await doc.ref.update({ synced: true, syncedAt: new Date().toISOString() });
      synced++;
    }
    
    res.json({ success: true, synced });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WhatsApp member code handler
app.post("/webhook/whatsapp-member", async (req, res) => {
  try {
    const customerPhone = req.body.from?.replace(/\D/g, '') || '';
    const message = req.body.text?.trim() || '';
    
    // Check if message is Member Code (DKxxxx)
    if (message.match(/^DK\d{4,6}$/i)) {
      let memberCode = message.toUpperCase();
      let users = await db.collection("users").where("dkCode", "==", memberCode).get();
      if (users.empty) {
        await sendWhatsAppMessage(customerPhone, `❌ Code ${memberCode} not found. Send REGISTER to join.`);
      } else {
        await db.collection("whatsapp_sessions").doc(customerPhone).set({
          memberCode, step: "awaiting_payment", createdAt: new Date().toISOString()
        });
        await sendWhatsAppMessage(customerPhone, `✅ Welcome!\n\nTo pay any merchant, send:\nPAY [Merchant] [Amount]\n\nExamples:\nPAY Carrefour 5000\nPAY 123456 5000`);
      }
      return res.sendStatus(200);
    }
    
    // Handle PAY command
    if (message.toLowerCase().startsWith("pay ")) {
      let parts = message.split(" ");
      let merchantId = parts[1];
      let amount = parseFloat(parts[2]);
      let session = await db.collection("whatsapp_sessions").doc(customerPhone).get();
      
      if (!session.exists) {
        await sendWhatsAppMessage(customerPhone, "First send your Member Code (e.g., DK005) to login.");
        return res.sendStatus(200);
      }
      
      let fee = amount <= 1000 ? 10 : (amount <= 5000 ? 20 : (amount <= 20000 ? 50 : 100));
      let total = amount + fee;
      
      await sendWhatsAppMessage(customerPhone, `💰 Confirm:\nMerchant: ${merchantId}\nAmount: KES ${amount}\nFee: KES ${fee}\nTotal: KES ${total}\n\nReply 1=Card 2=M-Pesa`);
      await session.ref.update({ merchantId, amount, fee, total, step: "awaiting_method" });
    }
    
    // Handle payment method
    if (message === "1") {
      let session = await db.collection("whatsapp_sessions").doc(customerPhone).get();
      if (session.exists && session.data().step === "awaiting_method") {
        let data = session.data();
        let paymentLink = `https://whapay.space/pay?amount=${data.amount}&merchant=${encodeURIComponent(data.merchantId)}&fee=${data.fee}`;
        await sendWhatsAppMessage(customerPhone, `💳 Pay: ${paymentLink}`);
        await session.ref.delete();
      }
    }
    if (message === "2") {
      let session = await db.collection("whatsapp_sessions").doc(customerPhone).get();
      if (session.exists && session.data().step === "awaiting_method") {
        await session.ref.update({ step: "awaiting_mpesa_phone" });
        await sendWhatsAppMessage(customerPhone, "📱 Enter M-Pesa phone number (e.g., 0712345678):");
      }
    }
    
    // Handle M-Pesa phone
    if (message.match(/^0?\d{9}$/) && customerPhone) {
      let session = await db.collection("whatsapp_sessions").doc(customerPhone).get();
      if (session.exists && session.data().step === "awaiting_mpesa_phone") {
        let data = session.data();
        let mpesaPhone = message.replace(/\D/g, '');
        if (mpesaPhone.startsWith("0")) mpesaPhone = "254" + mpesaPhone.substring(1);
        await sendWhatsAppMessage(customerPhone, `📱 STK push sent to ${mpesaPhone}\nAmount: KES ${data.total}`);
        await session.ref.delete();
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error("WhatsApp error:", error);
    res.sendStatus(500);
  }
});

// Retail store payment (merchant initiates)
app.post("/api/retail-pay", async (req, res) => {
  try {
    const { customerCode, merchantTill, amount, merchantName } = req.body;
    const customers = await db.collection("users").where("dkCode", "==", customerCode).get();
    if (customers.empty) {
      return res.status(404).json({ error: "Customer not found. Register via WhatsApp 0140933042" });
    }
    
    const customer = customers.docs[0].data();
    let fee = amount <= 1000 ? 10 : (amount <= 5000 ? 20 : (amount <= 20000 ? 50 : 100));
    let total = amount + fee;
    
    const transactionId = `RTL_${Date.now()}`;
    await db.collection("transactions").add({
      transactionId, customerCode, customerPhone: customer.phoneNumber,
      merchantTill, merchantName: merchantName || "Retail Store",
      amount, fee, total, status: "pending_payment", createdAt: new Date().toISOString()
    });
    
    await sendWhatsAppMessage(customer.phoneNumber,
      `🏪 Payment request\nStore: ${merchantName || merchantTill}\nAmount: KES ${amount}\nFee: KES ${fee}\nTotal: KES ${total}\n\nReply 1=Card 2=M-Pesa`);
    
    res.json({ success: true, transactionId, message: "Request sent to customer" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== UNIVERSAL MOBILE MONEY (All Networks) ==========

// Helper: Calculate customer fee for non-M-Pesa transactions
function calculateMobileMoneyFee(amount) {
  if (amount <= 500) return 10;
  if (amount <= 2000) return 20;
  if (amount <= 5000) return 30;
  if (amount <= 10000) return 50;
  return 100;
}

// Helper: Detect country and network from phone number
function detectCountryFromPhone(phoneNumber) {
  const cleanPhone = phoneNumber.replace(/\D/g, '');
  if (cleanPhone.startsWith('254')) return { country: 'KE', currency: 'KES', defaultNetwork: 'MPS' };
  if (cleanPhone.startsWith('256')) return { country: 'UG', currency: 'UGX', defaultNetwork: 'AIRTEL' };
  if (cleanPhone.startsWith('255')) return { country: 'TZ', currency: 'TZS', defaultNetwork: 'AIRTEL' };
  if (cleanPhone.startsWith('233')) return { country: 'GH', currency: 'GHS', defaultNetwork: 'MTN' };
  if (cleanPhone.startsWith('250')) return { country: 'RW', currency: 'RWF', defaultNetwork: 'MTN' };
  if (cleanPhone.startsWith('237')) return { country: 'CM', currency: 'XAF', defaultNetwork: 'MTN' };
  if (cleanPhone.startsWith('225')) return { country: 'CI', currency: 'XOF', defaultNetwork: 'ORANGE' };
  if (cleanPhone.startsWith('221')) return { country: 'SN', currency: 'XOF', defaultNetwork: 'ORANGE' };
  return { country: 'KE', currency: 'KES', defaultNetwork: 'MPS' };
}

// Network mapping for Flutterwave
const FLW_NETWORK_MAP = {
  'MPS': 'MPS',
  'AIRTEL': 'AIRTEL',
  'MTN': 'MTN',
  'TIGO': 'TIGO',
  'HALOPESA': 'HALOPESA',
  'ORANGE': 'ORANGE',
  'VODAFONE': 'VODAFONE'
};

// Initialize Flutterwave
let flw = null;
function initFlutterwave() {
  if (!flw && process.env.FLW_SECRET_KEY) {
    const Flutterwave = require('flutterwave-node-v3');
    flw = new Flutterwave(process.env.FLW_PUBLIC_KEY, process.env.FLW_SECRET_KEY);
    console.log("✅ Flutterwave initialized");
  }
  return flw;
}

// ========== 1. M-PESA (No Customer Fee) ==========
app.post("/api/mpesa/charge", async (req, res) => {
  try {
    const { merchantCode, customerPhone, customerName, amount } = req.body;
    
    if (!merchantCode || !customerPhone || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    // Clean phone number
    let cleanPhone = customerPhone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.substring(1);
    if (!cleanPhone.startsWith('254')) cleanPhone = '254' + cleanPhone;
    
    // Get merchant
    const merchants = await db.collection("users").where("dkCode", "==", merchantCode).get();
    if (merchants.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }
    const merchant = merchants.docs[0].data();
    
    // Initialize Flutterwave
    const flutterwave = initFlutterwave();
    if (!flutterwave) {
      return res.status(500).json({ error: "Flutterwave not configured" });
    }
    
    const tx_ref = `MPESA_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    const payload = {
      tx_ref: tx_ref,
      amount: parseFloat(amount),
      currency: "KES",
      phone_number: cleanPhone,
      email: customerName ? `${customerName.replace(/\s/g, '')}@whapay.user` : "customer@whapay.space",
      fullname: customerName || "WhaPay Customer",
      network: "MPS",
      country: "KE"
    };
    
    console.log(`💰 Initiating M-Pesa charge: KES ${amount} to ${cleanPhone}`);
    
    const response = await flutterwave.MobileMoney.charge(payload);
    
    if (response.status === 'success') {
      const transactionId = `MPESA_${Date.now()}`;
      await db.collection("transactions").add({
        transactionId,
        type: "mpesa",
        merchantCode,
        merchantName: merchant.fullname,
        amount: parseFloat(amount),
        customerPhone: cleanPhone,
        customerName: customerName || "Guest",
        status: "pending",
        customerFee: 0,
        totalPaid: parseFloat(amount),
        merchantReceives: parseFloat(amount),
        flutterwaveRef: response.data?.flw_ref,
        tx_ref: tx_ref,
        createdAt: new Date().toISOString()
      });
      
      res.json({
        success: true,
        message: "STK Push sent. Check your phone for M-Pesa prompt.",
        transactionId
      });
    } else {
      throw new Error(response.message || "Payment failed");
    }
    
  } catch (error) {
    console.error("M-Pesa error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== 2. OTHER MOBILE MONEY (Airtel, MTN, Orange, Tigo, etc.) WITH CUSTOMER FEE ==========
app.post("/api/mobile-money/charge", async (req, res) => {
  try {
    const { merchantCode, customerPhone, customerName, amount, network } = req.body;
    
    if (!merchantCode || !customerPhone || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    // Detect country from phone number
    const { country, currency, defaultNetwork } = detectCountryFromPhone(customerPhone);
    const selectedNetwork = network || defaultNetwork;
    const flutterwaveNetwork = FLW_NETWORK_MAP[selectedNetwork] || selectedNetwork;
    
    // Clean phone number
    let cleanPhone = customerPhone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) {
      if (country === 'KE') cleanPhone = '254' + cleanPhone.substring(1);
      else if (country === 'UG') cleanPhone = '256' + cleanPhone.substring(1);
      else if (country === 'TZ') cleanPhone = '255' + cleanPhone.substring(1);
      else if (country === 'GH') cleanPhone = '233' + cleanPhone.substring(1);
      else if (country === 'RW') cleanPhone = '250' + cleanPhone.substring(1);
      else if (country === 'CM') cleanPhone = '237' + cleanPhone.substring(1);
    }
    
    // Calculate customer fee
    const customerFee = calculateMobileMoneyFee(parseFloat(amount));
    const totalAmount = parseFloat(amount) + customerFee;
    
    // Get merchant
    const merchants = await db.collection("users").where("dkCode", "==", merchantCode).get();
    if (merchants.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }
    const merchant = merchants.docs[0].data();
    
    // Initialize Flutterwave
    const flutterwave = initFlutterwave();
    if (!flutterwave) {
      return res.status(500).json({ error: "Flutterwave not configured" });
    }
    
    const tx_ref = `MM_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    const payload = {
      tx_ref: tx_ref,
      amount: totalAmount,
      currency: currency,
      phone_number: cleanPhone,
      email: customerName ? `${customerName.replace(/\s/g, '')}@whapay.user` : "customer@whapay.space",
      fullname: customerName || "WhaPay Customer",
      network: flutterwaveNetwork,
      country: country,
      meta: {
        merchant_code: merchantCode,
        merchant_name: merchant.fullname,
        original_amount: amount,
        customer_fee: customerFee
      }
    };
    
    console.log(`💰 Initiating ${selectedNetwork} payment: ${totalAmount} ${currency} (fee: ${customerFee}) to ${cleanPhone}`);
    
    const response = await flutterwave.MobileMoney.charge(payload);
    
    if (response.status === 'success') {
      const transactionId = `MM_${Date.now()}`;
      await db.collection("transactions").add({
        transactionId,
        type: "mobile_money",
        network: selectedNetwork,
        country: country,
        currency: currency,
        merchantCode,
        merchantName: merchant.fullname,
        originalAmount: parseFloat(amount),
        customerFee: customerFee,
        totalPaid: totalAmount,
        merchantReceives: parseFloat(amount),
        customerPhone: cleanPhone,
        customerName: customerName || "Guest",
        status: "pending",
        flutterwaveRef: response.data?.flw_ref,
        tx_ref: tx_ref,
        createdAt: new Date().toISOString()
      });
      
      res.json({
        success: true,
        message: `Payment request sent to ${cleanPhone}. Check your phone for ${selectedNetwork} prompt.`,
        transactionId,
        amount: amount,
        fee: customerFee,
        total: totalAmount,
        currency: currency
      });
    } else {
      throw new Error(response.message || "Payment failed");
    }
    
  } catch (error) {
    console.error("Mobile money error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== 3. UNIVERSAL WEBHOOK (For all mobile money networks) ==========
app.post("/api/mobile-money/webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("📥 Mobile money webhook received:", event);
    
    // Check for successful payment
    const isSuccessful = event.status === 'successful' || event.data?.status === 'successful';
    
    if (isSuccessful) {
      const tx_ref = event.data?.tx_ref || event.tx_ref;
      const flutterwaveRef = event.data?.flw_ref || event.flw_ref;
      
      // Find and update transaction
      const transactions = await db.collection("transactions")
        .where("tx_ref", "==", tx_ref)
        .get();
      
      if (!transactions.empty) {
        const transaction = transactions.docs[0];
        const data = transaction.data();
        
        await transaction.ref.update({
          status: "completed",
          flutterwaveRef: flutterwaveRef,
          completedAt: new Date().toISOString()
        });
        
        // Send receipt to customer
        let receiptMessage = `✅ Payment successful!\n\n`;
        receiptMessage += `Amount: ${data.currency || 'KES'} ${data.originalAmount || data.amount}\n`;
        if (data.customerFee > 0) {
          receiptMessage += `WhaPay fee: ${data.currency || 'KES'} ${data.customerFee}\n`;
          receiptMessage += `Total paid: ${data.currency || 'KES'} ${data.totalPaid}\n`;
        }
        receiptMessage += `\nMerchant: ${data.merchantName}\n`;
        receiptMessage += `Thank you for using WhaPay!`;
        
        await sendWhatsAppMessage(data.customerPhone, receiptMessage);
        
        // Send merchant notification
        await sendWhatsAppMessage(data.merchantPhone, 
          `💰 Payment received!\n\nCustomer: ${data.customerName}\nAmount: ${data.currency || 'KES'} ${data.merchantReceives || data.amount}\n\nView in dashboard: https://whapay.space/reports.html`);
      }
    }
    
    res.status(200).json({ status: "success" });
    
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: error.message });
  }
});


// ========== ALIAS ENDPOINTS FOR SPECIFIC MOBILE MONEY NETWORKS ==========
// These allow frontend to call /api/airtel/charge, /api/mtn/charge, etc.
// They simply redirect to the universal /api/mobile-money/charge endpoint

app.post("/api/airtel/charge", async (req, res) => {
  req.body.network = "AIRTEL";
  return require('express')().
    post('/api/mobile-money/charge', async (req2, res2) => {
      try {
        const { merchantCode, customerPhone, customerName, amount, email } = req.body;
        const flutterwave = initFlutterwave();
        if (!flutterwave) {
          return res2.status(500).json({ error: "Flutterwave not configured. Add FLW_SECRET_KEY to environment variables." });
        }
        
        const { country, currency } = detectCountryFromPhone(customerPhone);
        let cleanPhone = customerPhone.replace(/\D/g, '');
        if (cleanPhone.startsWith('0')) {
          if (country === 'KE') cleanPhone = '254' + cleanPhone.substring(1);
          else if (country === 'UG') cleanPhone = '256' + cleanPhone.substring(1);
          else if (country === 'TZ') cleanPhone = '255' + cleanPhone.substring(1);
        }
        
        const customerFee = calculateMobileMoneyFee(parseFloat(amount));
        const totalAmount = parseFloat(amount) + customerFee;
        const tx_ref = `AIRTEL_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        
        const payload = {
          tx_ref: tx_ref,
          amount: totalAmount,
          currency: currency,
          phone_number: cleanPhone,
          email: email || `${cleanPhone}@whapay.user`,
          fullname: customerName || "WhaPay Customer",
          network: "AIRTEL",
          country: country,
          meta: { original_amount: amount, customer_fee: customerFee }
        };
        
        const response = await flutterwave.MobileMoney.charge(payload);
        
        if (response.status === 'success') {
          await db.collection("transactions").add({
            transactionId: tx_ref,
            type: "airtel",
            merchantCode,
            amount: parseFloat(amount),
            customerFee: customerFee,
            totalPaid: totalAmount,
            customerPhone: cleanPhone,
            status: "pending",
            createdAt: new Date().toISOString()
          });
          res2.json({ success: true, message: "Airtel Money payment initiated!", transactionId: tx_ref, amount: amount, fee: customerFee, total: totalAmount });
        } else {
          throw new Error(response.message || "Airtel payment failed");
        }
      } catch (error) {
        console.error("Airtel error:", error);
        res2.status(500).json({ success: false, error: error.message });
      }
    })(req, res);
});

app.post("/api/mtn/charge", async (req, res) => {
  req.body.network = "MTN";
  try {
    const { merchantCode, customerPhone, customerName, amount, email } = req.body;
    const flutterwave = initFlutterwave();
    if (!flutterwave) {
      return res.status(500).json({ error: "Flutterwave not configured" });
    }
    
    let cleanPhone = customerPhone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '256' + cleanPhone.substring(1);
    if (!cleanPhone.startsWith('256')) cleanPhone = '256' + cleanPhone;
    
    const customerFee = calculateMobileMoneyFee(parseFloat(amount));
    const totalAmount = parseFloat(amount) + customerFee;
    const tx_ref = `MTN_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    const payload = {
      tx_ref: tx_ref,
      amount: totalAmount,
      currency: "UGX",
      phone_number: cleanPhone,
      email: email || `${cleanPhone}@whapay.user`,
      fullname: customerName || "WhaPay Customer",
      network: "MTN",
      country: "UG",
      meta: { original_amount: amount, customer_fee: customerFee }
    };
    
    const response = await flutterwave.MobileMoney.charge(payload);
    
    if (response.status === 'success') {
      await db.collection("transactions").add({
        transactionId: tx_ref,
        type: "mtn",
        merchantCode,
        amount: parseFloat(amount),
        customerFee: customerFee,
        totalPaid: totalAmount,
        customerPhone: cleanPhone,
        status: "pending",
        createdAt: new Date().toISOString()
      });
      res.json({ success: true, message: "MTN Mobile Money payment initiated!", transactionId: tx_ref });
    } else {
      throw new Error(response.message || "MTN payment failed");
    }
  } catch (error) {
    console.error("MTN error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/tigo/charge", async (req, res) => {
  try {
    const { merchantCode, customerPhone, customerName, amount, email } = req.body;
    const flutterwave = initFlutterwave();
    if (!flutterwave) {
      return res.status(500).json({ error: "Flutterwave not configured" });
    }
    
    let cleanPhone = customerPhone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '255' + cleanPhone.substring(1);
    if (!cleanPhone.startsWith('255')) cleanPhone = '255' + cleanPhone;
    
    const customerFee = calculateMobileMoneyFee(parseFloat(amount));
    const totalAmount = parseFloat(amount) + customerFee;
    const tx_ref = `TIGO_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    const payload = {
      tx_ref: tx_ref,
      amount: totalAmount,
      currency: "TZS",
      phone_number: cleanPhone,
      email: email || `${cleanPhone}@whapay.user`,
      fullname: customerName || "WhaPay Customer",
      network: "TIGO",
      country: "TZ",
      meta: { original_amount: amount, customer_fee: customerFee }
    };
    
    const response = await flutterwave.MobileMoney.charge(payload);
    
    if (response.status === 'success') {
      await db.collection("transactions").add({
        transactionId: tx_ref,
        type: "tigo",
        merchantCode,
        amount: parseFloat(amount),
        customerFee: customerFee,
        totalPaid: totalAmount,
        customerPhone: cleanPhone,
        status: "pending",
        createdAt: new Date().toISOString()
      });
      res.json({ success: true, message: "Tigo Pesa payment initiated!", transactionId: tx_ref });
    } else {
      throw new Error(response.message || "Tigo payment failed");
    }
  } catch (error) {
    console.error("Tigo error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/orange/charge", async (req, res) => {
  try {
    const { merchantCode, customerPhone, customerName, amount, email, country } = req.body;
    const flutterwave = initFlutterwave();
    if (!flutterwave) {
      return res.status(500).json({ error: "Flutterwave not configured" });
    }
    
    const countryCode = country || 'CI';
    const currency = (countryCode === 'SN' || countryCode === 'CI') ? 'XOF' : 'XAF';
    const customerFee = calculateMobileMoneyFee(parseFloat(amount));
    const totalAmount = parseFloat(amount) + customerFee;
    const tx_ref = `ORANGE_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    
    const payload = {
      tx_ref: tx_ref,
      amount: totalAmount,
      currency: currency,
      phone_number: customerPhone,
      email: email || `${customerPhone.replace(/\D/g, '')}@whapay.user`,
      fullname: customerName || "WhaPay Customer",
      network: "ORANGE",
      country: countryCode,
      meta: { original_amount: amount, customer_fee: customerFee }
    };
    
    const response = await flutterwave.MobileMoney.charge(payload);
    
    if (response.status === 'success') {
      await db.collection("transactions").add({
        transactionId: tx_ref,
        type: "orange",
        merchantCode,
        amount: parseFloat(amount),
        customerFee: customerFee,
        totalPaid: totalAmount,
        customerPhone: customerPhone,
        status: "pending",
        createdAt: new Date().toISOString()
      });
      res.json({ success: true, message: "Orange Money payment initiated!", transactionId: tx_ref });
    } else {
      throw new Error(response.message || "Orange payment failed");
    }
  } catch (error) {
    console.error("Orange error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== CARD PAYMENT (NO DUPLICATE) ==========
app.post("/api/card/charge", async (req, res) => {
  try {
    const { merchantCode, customerEmail, customerName, amount, currency, cardNumber, cvv, expiryMonth, expiryYear } = req.body;
    if (!merchantCode || !customerEmail || !amount || !cardNumber || !cvv || !expiryMonth || !expiryYear) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    const flutterwave = initFlutterwave();
    if (!flutterwave) {
      return res.status(500).json({ success: false, error: "Flutterwave not configured" });
    }
    const tx_ref = `CARD_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const payload = {
      card_number: cardNumber.replace(/\s/g, ''),
      cvv,
      expiry_month: expiryMonth,
      expiry_year: expiryYear,
      currency: currency || "KES",
      amount: Math.round(amount),
      fullname: customerName || "WhaPay Customer",
      email: customerEmail,
      tx_ref,
      redirect_url: "https://whapay.space/payment-callback",
      authorization: { mode: "pin" }
    };
    const response = await flutterwave.Charge.card(payload);
    if (response.status === "success") {
      if (response.data?.redirect_url) {
        return res.json({ success: true, requiresAction: true, redirectUrl: response.data.redirect_url, tx_ref });
      }
      await db.collection("transactions").add({
        transactionId: tx_ref,
        merchantCode,
        customerEmail,
        customerName: customerName || "Guest",
        amount,
        method: "card",
        status: "completed",
        flutterwaveRef: response.data?.id,
        createdAt: new Date().toISOString()
      });
      res.json({ success: true, data: response.data, tx_ref });
    } else {
      throw new Error(response.message || "Card payment failed");
    }
  } catch (error) {
    console.error("Card error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== REGISTER & PAY V2 (returns memberCode) ==========
app.post("/api/register-pay-v2", async (req, res) => {
  try {
    const { fullname, phoneNumber, amount, paymentMethod, registerUser } = req.body;
    if (!fullname || !phoneNumber || !amount) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    let normalizedPhone = phoneNumber.replace(/^0+/, "254");
    if (!normalizedPhone.startsWith("254")) normalizedPhone = "254" + normalizedPhone;
    let memberCode = null;
    let user = null;
    if (registerUser === true) {
      const existing = await db.collection("users").where("phoneNumber", "==", normalizedPhone).get();
      if (existing.empty) {
        const dkCode = await getNextDkCode();
        const qrData = `https://whapay-backend.onrender.com/pay?code=${dkCode}`;
        const qrImage = await generateQRCode(qrData);
        const newUser = {
          phoneNumber: normalizedPhone,
          fullname: fullname,
          dkCode,
          qrCodeUrl: qrImage,
          userType: "customer",
          balance: 0,
          createdAt: new Date().toISOString()
        };
        const docRef = await db.collection("users").add(newUser);
        user = { id: docRef.id, ...newUser };
        memberCode = dkCode;
      } else {
        user = existing.docs[0].data();
        memberCode = user.dkCode;
      }
    }
    const transactionId = `TXN_${Date.now()}`;
    await db.collection("transactions").add({
      transactionId,
      customerName: fullname,
      customerPhone: normalizedPhone,
      amount: parseFloat(amount),
      paymentMethod,
      status: "pending",
      createdAt: new Date().toISOString()
    });
    res.json({
      success: true,
      user: user ? { dkCode: user.dkCode, qrCodeUrl: user.qrCodeUrl, fullname: user.fullname, phoneNumber: user.phoneNumber } : null,
      memberCode
    });
  } catch (error) {
    console.error("Register-pay error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== MOBILE MONEY V2 (NO EXTRA FEE) ==========
app.post("/api/mobile-money/charge-v2", async (req, res) => {
  try {
    const { merchantCode, customerPhone, customerName, amount, network, country, currency } = req.body;
    if (!merchantCode || !customerPhone || !amount || !network) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    const flutterwave = initFlutterwave();
    if (!flutterwave) {
      return res.status(500).json({ success: false, error: "Flutterwave not configured" });
    }
    let cleanPhone = customerPhone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) {
      if (country === 'KE') cleanPhone = '254' + cleanPhone.substring(1);
      else if (country === 'UG') cleanPhone = '256' + cleanPhone.substring(1);
      else if (country === 'TZ') cleanPhone = '255' + cleanPhone.substring(1);
    }
    const tx_ref = `MMV2_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const totalAmount = parseFloat(amount); // frontend already added fee
    const payload = {
      tx_ref,
      amount: totalAmount,
      currency: currency || "KES",
      phone_number: cleanPhone,
      email: `${merchantCode}@whapay.space`,
      fullname: customerName || "WhaPay Customer",
      network: network.toUpperCase(),
      country: country || "KE",
      meta: { merchant_code: merchantCode }
    };
    let response;
    switch (network.toUpperCase()) {
      case 'AIRTEL': response = await flutterwave.MobileMoney.airtel(payload); break;
      case 'MTN': response = await flutterwave.MobileMoney.mtn(payload); break;
      case 'TIGO': response = await flutterwave.MobileMoney.tigo(payload); break;
      case 'ORANGE': response = await flutterwave.MobileMoney.orange(payload); break;
      case 'VODAFONE': response = await flutterwave.MobileMoney.vodafone(payload); break;
      default: throw new Error("Unsupported network");
    }
    if (response.status === 'success') {
      await db.collection("transactions").add({
        transactionId: tx_ref,
        merchantCode,
        customerPhone: cleanPhone,
        customerName: customerName || "Guest",
        amount: totalAmount,
        method: network.toLowerCase(),
        status: "pending",
        flutterwaveRef: response.data?.flw_ref,
        createdAt: new Date().toISOString()
      });
      res.json({ success: true, message: `${network} payment initiated`, tx_ref });
    } else {
      throw new Error(response.message || "Payment failed");
    }
  } catch (error) {
    console.error("Mobile money v2 error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== 4. CHECK TRANSACTION STATUS ==========
app.get("/api/transaction/status/:transactionId", async (req, res) => {
  try {
    const { transactionId } = req.params;
    const transaction = await db.collection("transactions").doc(transactionId).get();
    
    if (!transaction.exists) {
      return res.status(404).json({ error: "Transaction not found" });
    }
    
    res.json({
      success: true,
      status: transaction.data().status,
      amount: transaction.data().amount,
      merchantCode: transaction.data().merchantCode
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== 5. GET SUPPORTED NETWORKS BY COUNTRY ==========
app.get("/api/mobile-money/networks", async (req, res) => {
  const networksByCountry = {
    'KE': { country: 'Kenya', currency: 'KES', networks: ['M-Pesa'] },
    'UG': { country: 'Uganda', currency: 'UGX', networks: ['Airtel', 'MTN'] },
    'TZ': { country: 'Tanzania', currency: 'TZS', networks: ['Airtel', 'Tigo', 'Halopesa'] },
    'GH': { country: 'Ghana', currency: 'GHS', networks: ['MTN', 'Vodafone', 'AirtelTigo'] },
    'RW': { country: 'Rwanda', currency: 'RWF', networks: ['Airtel', 'MTN'] },
    'CM': { country: 'Cameroon', currency: 'XAF', networks: ['MTN', 'Orange'] },
    'CI': { country: 'Côte d\'Ivoire', currency: 'XOF', networks: ['MTN', 'Orange', 'Moov', 'Wave'] },
    'SN': { country: 'Senegal', currency: 'XOF', networks: ['Orange', 'Free Money', 'Wave'] }
  };
  
  res.json({ success: true, networks: networksByCountry });
});


app.get("/pay", (req, res) => {
  const prefillCode = req.query.code || "";
  res.send(`<!DOCTYPE html>
<html>
<head><title>Pay with Whapay</title>
<style>body { font-family: Arial; padding: 20px; background: #f5f5f5; }
.container { max-width: 500px; margin: auto; background: white; padding: 30px; border-radius: 10px; }
input, button, select { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; }
button { background: #25D366; color: white; border: none; cursor: pointer; }</style>
</head>
<body>
<div class="container">
<h2>💰 Make a Payment</h2>
<select id="paymentMethod">
<option value="whatsapp">WhatsApp (Online)</option>
<option value="sms">SMS (Offline)</option>
<option value="qr">QR Code (Offline)</option>
</select>
<input type="text" id="merchantCode" placeholder="Merchant Code (e.g., DK0001)" value="${prefillCode}">
<div id="qrSection" style="display:none;">
<input type="file" id="qrFile" accept="image/*" onchange="readQRCode(this)">
</div>
<input type="tel" id="customerPhone" placeholder="Your phone number (0712345678)">
<input type="text" id="customerName" placeholder="Your full name">
<input type="number" id="amount" placeholder="Amount (KES)">
<input type="text" id="description" placeholder="Description">
<button onclick="pay()">✅ Pay Now</button>
<div id="result"></div>
</div>
<script>
document.getElementById('paymentMethod').onchange = function() {
  document.getElementById('qrSection').style.display = this.value === 'qr' ? 'block' : 'none';
};
function readQRCode(input) { alert('QR scanner ready'); }
async function pay() {
  const paymentMethod = document.getElementById('paymentMethod').value;
  const merchantCode = document.getElementById('merchantCode').value;
  const customerPhone = document.getElementById('customerPhone').value;
  const customerName = document.getElementById('customerName').value;
  const amount = document.getElementById('amount').value;
  const description = document.getElementById('description').value;
  const resultDiv = document.getElementById('result');
  if (!merchantCode || !customerPhone || !amount) {
    resultDiv.innerHTML = '<p style="color:red">Please fill all fields</p>';
    return;
  }
  resultDiv.innerHTML = '<p>Processing...</p>';
  try {
    const response = await fetch('/api/pay-offline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantCode, customerPhone, customerName,
        amount: parseFloat(amount), description, paymentMethod
      })
    });
    const data = await response.json();
    if (data.success) {
      resultDiv.innerHTML = '<p style="color:green">✅ Payment successful! Receipt sent.</p>';
    } else {
      resultDiv.innerHTML = '<p style="color:red">❌ Payment failed: ' + data.reason + '</p>';
    }
  } catch (err) {
    resultDiv.innerHTML = '<p style="color:red">❌ Network error</p>';
  }
}
</script>
</body>
</html>`);
});

// ========== STANDALONE OFFLINE SYNC & RECEIPT (No existing code modified) ==========

// Store offline transaction
app.post("/api/offline/store", async (req, res) => {
  try {
    const { customerPhone, customerName, merchantName, merchantPhone, amount, paymentMethod } = req.body;
    
    const pendingId = `pending_${customerPhone}_${Date.now()}`;
    await db.collection("pending_offline").doc(pendingId).set({
      customerPhone, customerName, merchantName, merchantPhone, amount, paymentMethod,
      status: "pending",
      createdAt: new Date().toISOString()
    });
    
    res.json({ success: true, message: "Offline transaction stored" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sync all offline transactions for a customer
app.post("/api/offline/sync", async (req, res) => {
  try {
    const { customerPhone } = req.body;
    
    const pending = await db.collection("pending_offline")
      .where("customerPhone", "==", customerPhone)
      .where("status", "==", "pending")
      .get();
    
    if (pending.empty) {
      return res.json({ success: true, synced: 0 });
    }
    
    let synced = 0;
    for (const doc of pending.docs) {
      const data = doc.data();
      
      // Save to main transactions
      await db.collection("transactions").add({
        transactionId: `SYNC_${Date.now()}_${synced}`,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        merchantName: data.merchantName,
        merchantPhone: data.merchantPhone,
        amount: data.amount,
        paymentMethod: data.paymentMethod,
        status: "completed",
        syncedFromOffline: true,
        syncedAt: new Date().toISOString()
      });
      
      // Send receipt
      await sendWhatsAppMessage(data.customerPhone, 
        `🧾 *WhaPay Receipt*\n━━━━━━━━━━━━━━━━━━━━━\nAmount: KES ${data.amount}\nMerchant: ${data.merchantName}\nStatus: ✅ PAID\n━━━━━━━━━━━━━━━━━━━━━\nThank you!`);
      
      await doc.ref.update({ status: "synced", syncedAt: new Date().toISOString() });
      synced++;
    }
    
    res.json({ success: true, synced });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Check pending count
app.get("/api/offline/pending/:phone", async (req, res) => {
  try {
    const { phone } = req.params;
    const pending = await db.collection("pending_offline")
      .where("customerPhone", "==", phone)
      .where("status", "==", "pending")
      .get();
    
    res.json({ pending: pending.size });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== OFFLINE SYNC ENDPOINTS ==========
app.post("/api/offline/store", async (req, res) => {
  try {
    const { customerPhone, customerName, merchantName, merchantPhone, amount, paymentMethod } = req.body;
    const pendingId = `pending_${customerPhone}_${Date.now()}`;
    await db.collection("pending_offline").doc(pendingId).set({
      customerPhone, customerName, merchantName, merchantPhone, amount, paymentMethod,
      status: "pending",
      createdAt: new Date().toISOString()
    });
    res.json({ success: true, message: "Offline transaction stored" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/offline/pending/:phone", async (req, res) => {
  try {
    const { phone } = req.params;
    const pending = await db.collection("pending_offline")
      .where("customerPhone", "==", phone)
      .where("status", "==", "pending")
      .get();
    res.json({ pending: pending.size });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/offline/sync", async (req, res) => {
  try {
    const { customerPhone } = req.body;
    const pending = await db.collection("pending_offline")
      .where("customerPhone", "==", customerPhone)
      .where("status", "==", "pending")
      .get();
    
    if (pending.empty) return res.json({ success: true, synced: 0 });
    
    let synced = 0;
    for (const doc of pending.docs) {
      const data = doc.data();
      await db.collection("transactions").add({
        transactionId: `SYNC_${Date.now()}_${synced}`,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        merchantName: data.merchantName,
        merchantPhone: data.merchantPhone,
        amount: data.amount,
        paymentMethod: data.paymentMethod,
        status: "completed",
        syncedFromOffline: true,
        syncedAt: new Date().toISOString()
      });
      await doc.ref.update({ status: "synced", syncedAt: new Date().toISOString() });
      synced++;
    }
    res.json({ success: true, synced });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.get("/api/subscription/:merchantCode", async (req, res) => {
  try {
    const { merchantCode } = req.params;
    const merchants = await db.collection("users").where("dkCode", "==", merchantCode).get();
    if (merchants.empty) return res.status(404).json({ error: "Merchant not found" });
    
    const plan = merchants.docs[0].data().subscriptionPlan || "free";
    res.json({ success: true, plan, details: SUBSCRIPTION_PLANS[plan] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== RETAIL CHECKOUT ==========
app.post("/api/retail-pay", async (req, res) => {
  try {
    const { customerCode, merchantTill, amount, merchantName } = req.body;
    const customers = await db.collection("users").where("dkCode", "==", customerCode).get();
    if (customers.empty) {
      return res.status(404).json({ error: "Customer not found. Register via WhatsApp 0140933042" });
    }
    
    const customer = customers.docs[0].data();
    let fee = amount <= 1000 ? 10 : (amount <= 5000 ? 20 : (amount <= 20000 ? 50 : 100));
    let total = amount + fee;
    
    await db.collection("transactions").add({
      transactionId: `RTL_${Date.now()}`,
      customerCode,
      customerPhone: customer.phoneNumber,
      merchantTill,
      merchantName: merchantName || "Retail Store",
      amount,
      fee,
      total,
      status: "pending_payment",
      createdAt: new Date().toISOString()
    });
    
    await sendWhatsAppMessage(customer.phoneNumber,
      `🏪 Payment request\nStore: ${merchantName || merchantTill}\nAmount: KES ${amount}\nFee: KES ${fee}\nTotal: KES ${total}\n\nReply 1=Card 2=M-Pesa`);
    
    res.json({ success: true, message: "Request sent to customer" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== WHATSAPP STOREFRONT ==========
app.post("/api/merchant/storefront", async (req, res) => {
  try {
    const { merchantCode, enabled } = req.body;
    const merchants = await db.collection("users").where("dkCode", "==", merchantCode).get();
    if (merchants.empty) return res.status(404).json({ error: "Merchant not found" });
    await merchants.docs[0].ref.update({ storefrontEnabled: enabled });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/merchant/product", async (req, res) => {
  try {
    const { merchantCode, name, price, description } = req.body;
    const merchants = await db.collection("users").where("dkCode", "==", merchantCode).get();
    if (merchants.empty) return res.status(404).json({ error: "Merchant not found" });
    
    await db.collection("products").add({
      merchantCode,
      name,
      price: parseFloat(price),
      description: description || "",
      createdAt: new Date().toISOString()
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/merchant/products", async (req, res) => {
  try {
    const { merchantCode } = req.query;
    const products = await db.collection("products").where("merchantCode", "==", merchantCode).get();
    res.json(products.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/merchant/product", async (req, res) => {
  try {
    const { productId } = req.body;
    await db.collection("products").doc(productId).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/merchant", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>Whapay Merchant</title>
<style>body { font-family: Arial; padding: 20px; background: #f5f5f5; }
.container { max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 10px; }
input, button { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; }
button { background: #25D366; color: white; border: none; cursor: pointer; }
.code { font-size: 24px; font-weight: bold; text-align: center; padding: 20px; background: #f0f0f0; border-radius: 5px; }
.qr-code { text-align: center; margin: 20px 0; }
.qr-code img { max-width: 200px; }</style>
</head>
<body>
<div class="container">
<h2>🏪 Merchant Registration</h2>
<input type="tel" id="merchantPhone" placeholder="Your phone number (0712345678)">
<input type="text" id="merchantName" placeholder="Your business name">
<button onclick="register()">🔑 Register / Login</button>
<div id="info" style="display:none;">
<h3>Your Whapay Code</h3>
<div class="code" id="dkCode"></div>
<h3>Your QR Code</h3>
<div class="qr-code"><img id="qrImage" src=""></div>
<button onclick="downloadQR()">📥 Download QR Code</button>
<h3>Send Payment Request</h3>
<input type="tel" id="customerPhoneLink" placeholder="Customer phone">
<input type="number" id="amountLink" placeholder="Amount (KES)">
<input type="text" id="descLink" placeholder="Description">
<button onclick="sendLink()">📲 Send WhatsApp Link</button>
</div>
<div id="result"></div>
</div>
<script>
let currentUser = null;
async function register() {
  const phone = document.getElementById('merchantPhone').value;
  const name = document.getElementById('merchantName').value;
  const response = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phone, fullname: name, userType: 'merchant' })
  });
  const data = await response.json();
  if (data.success) {
    currentUser = data.user;
    document.getElementById('info').style.display = 'block';
    document.getElementById('dkCode').innerHTML = currentUser.dkCode;
    document.getElementById('qrImage').src = currentUser.qrCodeUrl;
  } else { alert('Error: ' + data.error); }
}
function downloadQR() {
  if (currentUser && currentUser.qrCodeUrl) {
    const link = document.createElement('a');
    link.download = 'whapay-qr.png';
    link.href = currentUser.qrCodeUrl;
    link.click();
  }
}
async function sendLink() {
  const phone = document.getElementById('customerPhoneLink').value;
  const amount = document.getElementById('amountLink').value;
  const desc = document.getElementById('descLink').value;
  const response = await fetch('/api/create-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantCode: currentUser.dkCode, customerPhone: phone, amount: parseFloat(amount), description: desc })
  });
  const data = await response.json();
  if (data.success) window.open(data.whatsapp_link, '_blank');
  else alert('Error: ' + data.error);
}
</script>
</body>
</html>`);
});


// Flutterwave webhook endpoint (placeholder)
app.post("/api/flw-webhook", async (req, res) => {
  console.log("📥 Webhook received from Flutterwave:", req.body);
  
  try {
    const event = req.body;
    
    // Check for successful payment
    const isSuccessful = event.status === 'successful' || event.data?.status === 'successful';
    
    if (isSuccessful && event.data?.tx_ref) {
      const tx_ref = event.data.tx_ref;
      const flutterwaveRef = event.data.flw_ref;
      const amount = event.data.amount;
      const currency = event.data.currency;
      
      console.log(`✅ Successful payment detected: ${tx_ref}`);
      
      // Find and update transaction in Firestore
      const transactions = await db.collection("transactions")
        .where("transactionId", "==", tx_ref)
        .get();
      
      if (!transactions.empty) {
        const transaction = transactions.docs[0];
        const data = transaction.data();
        
        // Update transaction status
        await transaction.ref.update({
          status: "completed",
          flutterwaveRef: flutterwaveRef,
          completedAt: new Date().toISOString()
        });
        
        console.log(`✅ Transaction ${tx_ref} updated to completed`);
        
        // Send receipt to customer via WhatsApp
        if (data.customerPhone) {
          let receiptMessage = `✅ Payment successful!\n\n`;
          receiptMessage += `Amount: ${currency || 'KES'} ${data.originalAmount || data.amount}\n`;
          if (data.customerFee && data.customerFee > 0) {
            receiptMessage += `WhaPay fee: ${currency || 'KES'} ${data.customerFee}\n`;
            receiptMessage += `Total paid: ${currency || 'KES'} ${data.totalPaid}\n`;
          }
          receiptMessage += `\nMerchant: ${data.merchantCode}\n`;
          receiptMessage += `\nThank you for using WhaPay!`;
          
          // Send WhatsApp message (opens chat)
          const waLink = `https://wa.me/${data.customerPhone}?text=${encodeURIComponent(receiptMessage)}`;
          console.log(`Receipt link: ${waLink}`);
        }
      } else {
        console.log(`⚠️ Transaction not found for tx_ref: ${tx_ref}`);
      }
    } else {
      console.log(`Webhook event: ${event.event || 'unknown'} - status: ${event.status}`);
    }
    
    // Always respond with 200 to acknowledge receipt
    res.status(200).json({ status: "success", message: "Webhook received" });
    
  } catch (error) {
    console.error("Webhook error:", error);
    // Still return 200 to prevent Flutterwave from retrying
    res.status(200).json({ status: "error", message: error.message });
  }
});

app.post("/api/register-pay", async (req, res) => {
  try {
    const { fullname, phoneNumber, amount, paymentMethod, registerUser } = req.body;

    if (!fullname || !phoneNumber || !amount) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const customerPayAmount = amount + 50;
    let normalizedPhone = phoneNumber.replace(/^0+/, "254");
    if (!normalizedPhone.startsWith("254")) normalizedPhone = "254" + normalizedPhone;

    let user = null;
    let isNewUser = false;
    const existingUsers = await db.collection("users").where("phoneNumber", "==", normalizedPhone).get();
    
    if (existingUsers.empty && registerUser === true) {
      const dkCode = await getNextDkCode();
      const qrData = `https://whapay-backend.onrender.com/pay?code=${dkCode}`;
      const qrImage = await generateQRCode(qrData);
      const newUser = {
        phoneNumber: normalizedPhone,
        fullname: fullname,
        dkCode,
        qrCodeUrl: qrImage,
        userType: "customer",
        balance: 0,
        createdAt: new Date().toISOString(),
      };
      const docRef = await db.collection("users").add(newUser);
      user = { id: docRef.id, ...newUser };
      isNewUser = true;
    } else if (!existingUsers.empty) {
      user = existingUsers.docs[0].data();
      user.id = existingUsers.docs[0].id;
    }

    const transactionId = "TXN_" + Date.now();
    await db.collection("transactions").add({
      transactionId,
      customerName: fullname,
      customerPhone: normalizedPhone,
      amount: customerPayAmount,
      paymentMethod,
      status: "pending",
      createdAt: new Date().toISOString(),
      userCreated: isNewUser,
    });

    const PAYSTACK_SECRET = 'sk_test_dd7bfc8ccdae3b7eda8e0dba3ad37335';
    
    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: `${normalizedPhone}@whapay.space`,
        amount: customerPayAmount * 100,
        currency: "KES",
        metadata: {
          customerName: fullname,
          customerPhone: normalizedPhone,
          transactionId: transactionId,
          type: "registration"
        },
        callback_url: "https://whapay.space/payment-callback"
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    if (!paystackResponse.data || !paystackResponse.data.status) {
      throw new Error(paystackResponse.data?.message || "Paystack initialization failed");
    }

    res.json({
      success: true,
      transactionId,
      paymentLink: paystackResponse.data.data.authorization_url,
      user: user ? {
        dkCode: user.dkCode,
        qrCodeUrl: user.qrCodeUrl,
        fullname: user.fullname,
        phoneNumber: user.phoneNumber,
      } : null,
      isNewUser,
    });
  } catch (error) {
    console.error("Register-pay error:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});
    
app.post("/api/pay-offline", async (req, res) => {
  try {
    const { merchantCode, customerPhone, customerName, amount, description, paymentMethod } = req.body;
    const idempotencyKey = req.idempotencyKey;
    console.log(`Idempotency key: ${idempotencyKey}`);

    const merchants = await db.collection("users").where("dkCode", "==", merchantCode).get();
    if (merchants.empty) throw new Error("Merchant not found");
    const merchant = merchants.docs[0];
    const merchantData = merchant.data();

    const customer = await registerOrGetUser(customerPhone, customerName, "customer");
    const transactionId = "TXN_" + Date.now();

    await saveTransaction({
      transactionId,
      merchantCode: merchantData.dkCode,
      merchantName: merchantData.fullname,
      customerCode: customer.dkCode,
      customerName: customer.fullname,
      amount,
      description,
      status: "completed",
      paymentMethod
    });

    await sendConfirmations({
      transactionId,
      merchant: { fullname: merchantData.fullname, dkCode: merchantData.dkCode, phoneNumber: merchantData.phoneNumber },
      customer: { fullname: customer.fullname, dkCode: customer.dkCode, phoneNumber: customer.phoneNumber },
      amount,
      description,
      status: "success",
      reason: null,
      paymentMethod
    });

    res.json({ success: true, transactionId });
  } catch (error) {
    console.error(error);
    res.json({ success: false, error: error.message, reason: error.message });
  }
});

app.post("/api/create-link", async (req, res) => {
  try {
    const { merchantCode, customerPhone, amount, description } = req.body;
    const merchants = await db.collection("users").where("dkCode", "==", merchantCode).get();
    if (merchants.empty) throw new Error("Merchant not found");
    const merchant = merchants.docs[0];
    const merchantData = merchant.data();
    let normalizedPhone = customerPhone.replace(/^0+/, "254");
    const paymentLink = `https://whapay-backend.onrender.com/pay?code=${merchantCode}`;
    const message = `Pay KES ${amount} to ${merchantData.fullname} (${merchantData.dkCode}) for ${description || "payment"}. Click: ${paymentLink}`;
    const whatsappLink = `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(message)}`;
    await saveTransaction({
      transactionId: "PENDING_" + Date.now(), merchantCode: merchantData.dkCode, merchantName: merchantData.fullname,
      customerPhone: normalizedPhone, amount, description, status: "pending", paymentMethod: "whatsapp"
    });
    res.json({ success: true, whatsapp_link: whatsappLink, payment_link: paymentLink });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});


// ========================
// Send SMS via Twilio
// ========================
app.post("/api/send-sms", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error("Twilio credentials not set");
    }
    
    const twilioClient = require('twilio')(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    
    const response = await twilioClient.messages.create({
      body: message,
      to: to,
      from: process.env.TWILIO_PHONE_NUMBER
    });
    
    res.json({ success: true, sid: response.sid });
  } catch (error) {
    console.error("Twilio SMS error:", error.message);
    res.json({ success: false, error: error.message });
  }
});

// ========== DEVELOPER PORTAL ROUTES ==========

// Serve developer.html
app.get('/developer.html', (req, res) => {
  res.sendFile(__dirname + '/developer.html');
});

// API Docs (Swagger UI)
app.get('/api-docs', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhaPay API Docs</title>
      <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
    </head>
    <body>
      <div id="swagger-ui"></div>
      <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
      <script>
        window.onload = () => {
          SwaggerUIBundle({
            url: "/swagger.yaml",
            dom_id: "#swagger-ui"
          });
        };
      </script>
    </body>
    </html>
  `);
});

// Serve swagger.yaml
app.get('/swagger.yaml', (req, res) => {
  res.sendFile(__dirname + '/swagger.yaml');
});

// API Playground
app.get('/developer/playground', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
   <head>
      <title>API Playground</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-50">
      <div class="max-w-4xl mx-auto p-6">
        <h1 class="text-2xl font-bold mb-4">🪄 API Playground</h1>
        <div class="bg-white rounded-xl p-6 shadow-sm">
          <label class="block text-sm font-medium mb-2">Endpoint</label>
          <select id="endpoint" class="w-full border rounded-lg p-2 mb-4">
            <option value="/api/pay-offline">POST /api/pay-offline</option>
            <option value="/api/stats">GET /api/stats</option>
          </select>
          <label class="block text-sm font-medium mb-2">Request Body (JSON)</label>
          <textarea id="body" rows="6" class="w-full font-mono text-sm border rounded-lg p-3 mb-4">{
  "merchantCode": "DK0001",
  "customerPhone": "254712345678",
  "amount": 500
}</textarea>
          <button onclick="sendRequest()" class="bg-green-600 text-white px-4 py-2 rounded-lg">Send Request</button>
          <div class="mt-4">
            <label class="block text-sm font-medium mb-2">Response</label>
            <pre id="response" class="bg-gray-900 text-green-400 p-4 rounded-lg overflow-x-auto">Click Send to see response</pre>
          </div>
        </div>
      </div>
      <script>
        async function sendRequest() {
          const endpoint = document.getElementById('endpoint').value;
          const bodyText = document.getElementById('body').value;
          const method = endpoint.includes('/stats') ? 'GET' : 'POST';
          const responseDiv = document.getElementById('response');
          responseDiv.innerText = 'Loading...';
          try {
            const response = await fetch(endpoint, {
              method: method,
              headers: { 'Content-Type': 'application/json' },
              body: method === 'POST' ? bodyText : undefined
            });
            const data = await response.json();
            responseDiv.innerText = JSON.stringify(data, null, 2);
          } catch(err) {
            responseDiv.innerText = 'Error: ' + err.message;
          }
        }
      </script>
    </body>
    </html>
  `);
});

// System Status page
app.get('/developer/status', async (req, res) => {
  let dbStatus = 'operational';
  try {
    await db.collection('_health').doc('ping').set({ ping: Date.now() });
  } catch(e) {
    dbStatus = 'degraded';
  }
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhaPay Status</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <meta http-equiv="refresh" content="30">
    </head>
    <body class="bg-gray-50">
      <div class="max-w-4xl mx-auto p-6">
        <h1 class="text-2xl font-bold mb-2">🟢 System Status</h1>
        <div class="bg-green-100 border border-green-300 rounded-lg p-4 mb-4">
          <div class="flex items-center gap-2">
            <div class="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
            <span class="font-bold">All systems operational</span>
          </div>
          <p class="text-sm text-gray-600 mt-2">Database: ${dbStatus}</p>
          <p class="text-sm text-gray-600">API: operational</p>
          <p class="text-sm text-gray-600">Flutterwave: pending approval</p>
        </div>
        <p class="text-sm text-gray-400">Page auto-refreshes every 30 seconds</p>
      </div>
    </body>
    </html>
  `);
});
// ========================
// Twilio Incoming SMS (Customer texts to register)
// ========================
function generateMembershipCode() {
  return 'DK' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
}

app.post('/api/incoming-sms', (req, res) => {
  const customerNumber = req.body.From;
  const messageText = req.body.Body || '';
  
  console.log(`📨 SMS from ${customerNumber}: ${messageText}`);

  let reply = '';
  if (messageText.toLowerCase().includes('register')) {
    const tempId = 'REG_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const paymentLink = `https://whapay.space/pay.html?amount=100&purpose=registration&tempId=${tempId}&phone=${encodeURIComponent(customerNumber)}`;
    reply = `Registration fee is KES 100. Click here to pay: ${paymentLink}`;
  } else {
    reply = 'Reply "register" to get your WhaPay membership code.';
  }

  const twiml = new MessagingResponse();
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

// ========================
// Twilio Incoming Voice Call (Customer calls to register)
// ========================
app.post('/api/incoming-call', (req, res) => {
  const callerNumber = req.body.From;
  console.log(`📞 Call from ${callerNumber}`);
  const newCode = generateMembershipCode();
  // Save to Firestore if needed

  const twiml = new VoiceResponse();
  twiml.say(`Thank you for calling WhaPay. Your membership code is ${newCode}. Please write it down.`);
  res.type('text/xml').send(twiml.toString());
});

// ========================
// Outbound Voice Call via Twilio
// ========================
app.post('/api/voice/call', async (req, res) => {
  const { to, message = 'Hello from WhaPay.' } = req.body;
  if (!to) {
    return res.status(400).json({ error: 'Missing "to" phone number' });
  }
  try {
    const call = await twilioClient.calls.create({
      twiml: `<Response><Say>${message}</Say></Response>`,
      to: to,
      from: process.env.TWILIO_PHONE_NUMBER
    });
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    console.error('Twilio voice error:', error.message);
    res.status(500).json({ error: 'Voice call failed', details: error.message });
  }
});

// Serve static SDK files
app.use('/sdk', express.static('sdk'));
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Whapay system running on port ${PORT}`);
  console.log(`🌐 Open https://whapay-backend.onrender.com to test`);
});
