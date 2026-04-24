const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ========== M-PESA CONFIGURATION ==========
// Read from environment variables (set in Render)
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;

// Sandbox API URLs
const MPESA_API_BASE = 'https://sandbox.safaricom.co.ke';
const MPESA_STK_PUSH_URL = `${MPESA_API_BASE}/mpesa/stkpush/v1/processrequest`;
const MPESA_TOKEN_URL = `${MPESA_API_BASE}/oauth/v1/generate?grant_type=client_credentials`;

// ========== Helper: Get M-PESA Access Token ==========
async function getMpesaToken() {
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
    const response = await axios.get(MPESA_TOKEN_URL, {
        headers: { Authorization: `Basic ${auth}` }
    });
    return response.data.access_token;
}

// ========== Endpoint: M-PESA STK Push ==========
app.post('/stkpush', async (req, res) => {
    try {
        const { phone, amount, accountReference } = req.body;
        
        // Validate input
        if (!phone || !amount) {
            return res.status(400).json({ error: 'Phone and amount are required' });
        }
        
        const token = await getMpesaToken();
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
        
        const requestBody = {
            BusinessShortCode: MPESA_SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.round(amount),
            PartyA: phone,
            PartyB: MPESA_SHORTCODE,
            PhoneNumber: phone,
            CallBackURL: 'https://whapay-backend.onrender.com/callback',
            AccountReference: accountReference || 'WhaPay',
            TransactionDesc: 'Payment'
        };
        
        console.log('Sending STK Push request:', requestBody);
        
        const response = await axios.post(MPESA_STK_PUSH_URL, requestBody, {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        console.log('STK Push response:', response.data);
        res.json(response.data);
        
    } catch (error) {
        console.error('STK Push Error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: error.response?.data || error.message,
            details: error.response?.data 
        });
    }
});

// ========== Endpoint: M-PESA Callback ==========
app.post('/callback', (req, res) => {
    console.log('Payment Callback Received:', req.body);
    // TODO: Save transaction to database
    res.send('OK');
});

// ========== Health Check ==========
app.get('/', (req, res) => {
    res.send('WhaPay M-PESA Backend is running!');
});

// ========== Start Server ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`MPESA_SHORTCODE: ${MPESA_SHORTCODE}`);
    console.log(`MPESA_CONSUMER_KEY: ${MPESA_CONSUMER_KEY ? '✓ Set' : '✗ Missing'}`);
    console.log(`MPESA_CONSUMER_SECRET: ${MPESA_CONSUMER_SECRET ? '✓ Set' : '✗ Missing'}`);
    console.log(`MPESA_PASSKEY: ${MPESA_PASSKEY ? '✓ Set' : '✗ Missing'}`);
});
