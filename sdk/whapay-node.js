/**
 * WhaPay Node.js SDK
 * npm install whapay-sdk
 */
class WhaPay {
  constructor(apiKey, baseURL = 'https://whapay-backend.onrender.com/api') {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
  }

  async request(endpoint, method = 'POST', data = {}) {
    const response = await fetch(`${this.baseURL}${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: method !== 'GET' ? JSON.stringify(data) : undefined,
    });
    return response.json();
  }

  async createPayment(params) {
    return this.request('/pay-offline', 'POST', params);
  }

  async getStats() {
    return this.request('/stats', 'GET');
  }
}

module.exports = WhaPay;
