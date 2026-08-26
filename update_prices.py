import json
import time
import requests

def fetch_steam_info(app_id):
    url = f"https://store.steampowered.com/api/appdetails?appids={app_id}&cc=it&l=it"
    # Header e cookie per simulare un browser reale e bypassare il controllo età/mature content
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
        'Cookie': 'wants_mature_content=1; birthtime=0; lastagecheckage=1-0-1990'
    }
    
    for attempt in range(3):
        try:
            res = requests.get(url, headers=headers, timeout=10)
            if res.status_code == 200:
                json_data = res.json()
                app_data = json_data.get(str(app_id), {})
                
                if app_data.get('success') and app_data.get('data'):
                    g_data = app_data['data']
                    price_info = g_data.get('price_overview')
                    release_info = g_data.get('release_date', {})
                    
                    if release_info.get('coming_soon'):
                        date_str = release_info.get('date', 'TBA')
                        return {"status": f"Rilascio: {date_str}", "price": "N/D", "discount": "N/D"}
                    
                    if price_info:
                        final_price = f"€{price_info['final'] / 100:.2f}".replace('.', ',')
                        discount = f"{price_info['discount_percent']}%"
                        return {"status": final_price, "price": final_price, "discount": discount}
                    else:
                        if g_data.get('is_free'):
                            return {"status": "Gratuito", "price": "€0,00", "discount": "0%"}
                        return {"status": "Rilasciato (Prezzo N/D)", "price": "N/D", "discount": "N/D"}
                else:
                    print(f"[Tentativo {attempt+1}] Steam success=false per ID {app_id}")
            else:
                print(f"[Tentativo {attempt+1}] HTTP status {res.status_code} per ID {app_id}")
        except Exception as e:
            print(f"[Tentativo {attempt+1}] Errore ID {app_id}: {e}")
        
        time.sleep(2)
        
    return {"status": "Errore API", "price": "N/D", "discount": "N/D"}

def main():
    with open('games.json', 'r', encoding='utf-8') as f:
        games = json.load(f)

    for game in games:
        print(f"Aggiornamento: {game.get('title')} ({game.get('id')})")
        info = fetch_steam_info(game['id'])
        game['status'] = info['status']
        game['price'] = info['price']
        game['discount'] = info['discount']
        time.sleep(1.5)

    with open('games.json', 'w', encoding='utf-8') as f:
        json.dump(games, f, indent=2, ensure_ascii=False)

if __name__ == '__main__':
    main()
