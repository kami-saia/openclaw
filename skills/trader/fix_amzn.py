import os
import json
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest
from alpaca.trading.enums import OrderSide, TimeInForce

CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")
AMZN_ORDER_ID = "fd1e6eb8-48c8-459f-9d36-ea4b7426efe9"
NEW_QTY = 127

def main():
    with open(CRED_PATH, 'r') as f:
        creds = json.load(f)
    
    client = TradingClient(creds["APCA_API_KEY_ID"], creds["APCA_API_SECRET_KEY"], paper=True)
    
    try:
        print(f"🐺 Canceling Ghost AMZN Order {AMZN_ORDER_ID}...")
        try:
            client.cancel_order_by_id(AMZN_ORDER_ID)
            print("✅ Cancelled.")
        except Exception as cx:
            print(f"⚠️ Cancel Warning: {cx}")

        print(f"🐺 Placing New Order: Buy {NEW_QTY} AMZN @ Market...")
        req = MarketOrderRequest(
            symbol="AMZN",
            qty=NEW_QTY,
            side=OrderSide.BUY,
            time_in_force=TimeInForce.DAY
        )
        res = client.submit_order(order_data=req)
        print(f"✅ Order Submitted. ID: {res.id}")

    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    main()
