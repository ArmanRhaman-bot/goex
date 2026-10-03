import axios from "axios";

const API = "https://api.oxapay.com/v1";

function unwrap(res) {
  return res?.data?.data ?? res?.data ?? res;
}

export async function createInvoice({
  merchantKey, amount, currency = "USDT", callbackUrl, orderId, description, lifetime = 60
}) {
  const r = await axios.post(`${API}/payment/invoice`, {
    amount: Number(amount),
    currency,
    lifetime,
    callback_url: callbackUrl,
    order_id: String(orderId),
    description
  }, {
    headers: {
      merchant_api_key: merchantKey,
      "Content-Type": "application/json"
    },
    timeout: 20000
  });
  return unwrap(r);
}

export async function getPayment(trackId, merchantKey) {
  const r = await axios.get(`${API}/payment/${encodeURIComponent(trackId)}`, {
    headers: {
      merchant_api_key: merchantKey,
      "Content-Type": "application/json"
    },
    timeout: 20000
  });
  return unwrap(r);
}

export async function createPayout({
  payoutKey, address, currency, amount, network, callbackUrl, description
}) {
  const r = await axios.post(`${API}/payout`, {
    address,
    currency,
    amount: Number(amount),
    network,
    callback_url: callbackUrl,
    description
  }, {
    headers: {
      payout_api_key: payoutKey,
      "Content-Type": "application/json"
    },
    timeout: 20000
  });
  return unwrap(r);
}
