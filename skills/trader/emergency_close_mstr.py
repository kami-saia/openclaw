import alpaca_trade_api as tradeapi
import json
import os

# Load Credentials
CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")
with open(CRED_PATH) as f:
    creds = json.load(f)

api = tradeapi.REST(creds["APCA_API_KEY_ID"], creds["APCA_API_SECRET_KEY"], base_url="https://paper-api.alpaca.markets")

print("--- CLOSING POSITIONS ---")

# Close MSTR (Short -> Buy to Cover)
try:
    pos = api.get_position("MSTR")
    print(f"Found MSTR position: {pos.qty} shares. Closing...")
    order = api.submit_order(
        symbol="MSTR",
        qty=abs(int(pos.qty)),
        side="buy",  # Buy to cover short
        type="market",
        time_in_force="day"
    )
    print(f"MSTR Close Order Submitted: {order.id}")
except Exception as e:
    print(f"Error closing MSTR: {e}")

# Check COIN
try:
    pos = api.get_position("COIN")
    print(f"Found COIN position: {pos.qty} shares.")
    # We are not closing COIN yet, just identifying it.
except Exception as e:
    print(f"No COIN position found: {e}")
