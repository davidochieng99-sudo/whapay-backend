<?php
class WhaPay {
    private $apiKey;
    private $baseURL;

    public function __construct($apiKey, $baseURL = "https://whapay-backend.onrender.com/api") {
        $this->apiKey = $apiKey;
        $this->baseURL = $baseURL;
    }

    private function request($endpoint, $method = "POST", $data = []) {
        $ch = curl_init($this->baseURL . $endpoint);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            "Authorization: Bearer " . $this->apiKey,
            "Content-Type: application/json"
        ]);
        if ($method === "POST") {
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
        }
        $response = curl_exec($ch);
        curl_close($ch);
        return json_decode($response, true);
    }

    public function createPayment($merchantCode, $customerPhone, $amount, $description = null) {
        return $this->request("/pay-offline", "POST", [
            "merchantCode" => $merchantCode,
            "customerPhone" => $customerPhone,
            "amount" => $amount,
            "description" => $description
        ]);
    }

    public function getStats() {
        return $this->request("/stats", "GET");
    }
}
?>
