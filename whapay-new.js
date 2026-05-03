const express = require("express");
const cors = require("cors");
require("dotenv").config();
const QRCode = require("qrcode");
const admin = require("firebase-admin");
const axios = require("axios");


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
app.use(express.static("public"));
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

// Helper: send WhatsApp message (opens link)
async function sendWhatsAppMessage(phoneNumber, message) {
  const normalizedPhone = phoneNumber.replace(/^0+/, "254");
  const link = `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(message)}`;
  return { success: true, link };
}

// Helper: send SMS (placeholder – will work after Dexatel approval)
async function sendSMS(phoneNumber, message) {
  console.log(`SMS to ${phoneNumber}: ${message}`);
  return { success: true };
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

// Send receipts
async function sendConfirmations(paymentData) {
  const { transactionId, merchant, customer, amount, description, status, reason, paymentMethod } = paymentData;
  const now = new Date();
  const dateTime = now.toLocaleString();
  const customerReceipt = `
WHAPAY RECEIPT
Transaction: ${transactionId}
Customer: ${customer.fullname} (${customer.dkCode})
Merchant: ${merchant.fullname} (${merchant.dkCode})
Amount: KES ${amount}
Description: ${description || "Payment"}
Time: ${dateTime}
Status: ${status.toUpperCase()}
${reason ? `Reason: ${reason}` : ""}
Thank you for using Whapay!`;
  const merchantNotification = `
PAYMENT RECEIVED
Transaction: ${transactionId}
Customer: ${customer.fullname} (${customer.dkCode})
Amount: KES ${amount}
Description: ${description || "Payment"}
Time: ${dateTime}
Status: ${status.toUpperCase()}`;
  if (paymentMethod === "whatsapp") {
    await sendWhatsAppMessage(customer.phoneNumber, customerReceipt);
    await sendWhatsAppMessage(merchant.phoneNumber, merchantNotification);
  } else {
    await sendSMS(customer.phoneNumber, customerReceipt);
    await sendSMS(merchant.phoneNumber, merchantNotification);
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
  
  // TODO: After Flutterwave approval, we will:
  // 1. Verify the signature using your secret hash
  // 2. Update transaction status in Firestore
  // 3. Send confirmation to customer/merchant
  
  // Always respond with 200 to acknowledge receipt
  res.status(200).json({ status: "success", message: "Webhook received" });
});
// ---------- API endpoints ----------
app.post("/api/register", async (req, res) => {
  try {
    const { phoneNumber, fullname, userType } = req.body;
    const user = await registerOrGetUser(phoneNumber, fullname, userType);
    res.json({ success: true, user });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Register & Pay in one step (combines user creation and payment initialization)
app.post("/api/register-pay", async (req, res) => {
  try {
    const { fullname, phoneNumber, amount, paymentMethod, registerUser } = req.body;

    // Validate inputs
    if (!fullname || !phoneNumber || !amount) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    // Normalize phone number
    let normalizedPhone = phoneNumber.replace(/^0+/, "254");
    if (!normalizedPhone.startsWith("254")) normalizedPhone = "254" + normalizedPhone;

    // Register or get existing user
    let user = null;
    let isNewUser = false;
    const existingUsers = await db.collection("users").where("phoneNumber", "==", normalizedPhone).get();
    if (existingUsers.empty && registerUser === true) {
      // Create new user
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
    } else {
      // User doesn't exist and registerUser is false – treat as guest
      user = null;
    }

    // Create a transaction record with status "pending"
    const transactionId = "TXN_" + Date.now();
    const transactionData = {
      transactionId,
      customerName: fullname,
      customerPhone: normalizedPhone,
      amount: parseFloat(amount),
      paymentMethod,
      status: "pending",
      createdAt: new Date().toISOString(),
      userCreated: isNewUser,
    };
    await db.collection("transactions").add(transactionData);

    // TODO: After Flutterwave approval, replace this mock with actual payment initialization
    // For now, simulate a payment link
    const mockPaymentLink = `https://whapay-backend.onrender.com/pay?amount=${amount}&phone=${normalizedPhone}`;

    // Prepare response
    const response = {
      success: true,
      transactionId,
      paymentLink: mockPaymentLink,
      user: user ? {
        dkCode: user.dkCode,
        qrCodeUrl: user.qrCodeUrl,
        fullname: user.fullname,
        phoneNumber: user.phoneNumber,
      } : null,
      isNewUser,
    };

    res.json(response);
  } catch (error) {
    console.error("Register-pay error:", error);
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

// Fixed send-sms endpoint (correct headers placement)
app.post("/api/send-sms", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!process.env.DEXATEL_API_KEY) throw new Error("Dexatel API key not set");
    const response = await axios.post(
      "https://api.dexatel.com/v1/messages",
      { to, from: "Whapay", text: message },
      { headers: { "X-Dexatel-Key": process.env.DEXATEL_API_KEY, "Content-Type": "application/json" } }
    );
    res.json({ success: true, data: response.data });
  } catch (error) {
    res.json({ success: false, error: error.response?.data || error.message });
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

// Serve static SDK files
app.use('/sdk', express.static('sdk'));
// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Whapay system running on port ${PORT}`);
  console.log(`🌐 Open https://whapay-backend.onrender.com to test`);
});
