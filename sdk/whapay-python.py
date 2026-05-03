"""
WhaPay Python SDK
pip install requests
"""
import requests

class WhaPay:
    def __init__(self, api_key, base_url="https://whapay-backend.onrender.com/api"):
        self.api_key = api_key
        self.base_url = base_url

    def _request(self, endpoint, method="POST", data=None):
        url = f"{self.base_url}{endpoint}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        response = requests.request(method, url, headers=headers, json=data)
        return response.json()

    def create_payment(self, merchant_code, customer_phone, amount, description=None):
        return self._request("/pay-offline", "POST", {
            "merchantCode": merchant_code,
            "customerPhone": customer_phone,
            "amount": amount,
            "description": description
        })

    def get_stats(self):
        return self._request("/stats", "GET")
