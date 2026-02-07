import os
import json
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest
from alpaca.trading.enums import OrderSide, TimeInForce

CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")

def main():
    with open(CRED_PATH, 'r') as f:
        creds = json.load(f)
    
    client = TradingClient(creds["APCA_API_KEY_ID"], creds["APCA_API_SECRET_KEY"], paper=True)
    
    # RE-ENTER SHORT MSTR
    # 75 Shares @ Market
    print("Executing: SHORT MSTR (75 shares)...")
    req = MarketOrderRequest(
        symbol="MSTR",
        qty=75,
        side=OrderSide.SELL,
        time_in_force=TimeInForce.DAY
    )
    
    try:
        res = client.submit_order(req)
        print(f"Order Submitted: {res.id} | Status: {res.status}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main()
