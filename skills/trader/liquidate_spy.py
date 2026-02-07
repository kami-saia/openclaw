import os
import json
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import ClosePositionRequest

CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")

def main():
    with open(CRED_PATH, 'r') as f:
        creds = json.load(f)
    
    client = TradingClient(creds["APCA_API_KEY_ID"], creds["APCA_API_SECRET_KEY"], paper=True)
    
    try:
        print("🐺 Closing SPY Position...")
        # Close specific position
        client.close_position("SPY")
        print("✅ SPY Liquidation Order Submitted.")
            
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    main()
