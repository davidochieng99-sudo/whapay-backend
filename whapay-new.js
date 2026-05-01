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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Whapay system running on port ${PORT}`);
  console.log(`🌐 Open https://whapay-backend.onrender.com to test`);
});
