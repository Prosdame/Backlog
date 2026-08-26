import json
import time
import requests

STEAM_ID = "76561198836972183"

def fetch_wishlist_games(steam_id):
    wishlist_games = {}
    page = 0
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
        'Referer': f'https://store.steampowered.com/wishlist/profiles/{steam_id}/',
        'Cookie': 'wants_mature_content=1; birthtime=0; lastagecheckage=1-0-1990; timezoneOffset=3600,0'
    }
    
    while True:
        url = f"https://store.steampowered.com/wishlist/profiles/{steam_id}/wishlistdata/?p={page}"
        try:
            res = requests.get(url, headers=headers, timeout=12)
            if res.status_code == 200:
                try:
                    data = res.json()
                except json.JSONDecodeError:
                    print(f"[Wishlist] Risposta non JSON alla pagina {page}. Interruzione ciclo.")
                    break
                    
                if not data or isinstance(data, list) or (isinstance(data, dict) and data.get("success") == 2):
                    break
                
                for app_id, game_info in data.items():
                    if isinstance(game_info, dict) and 'name' in game_info:
                        wishlist_games[int(app_id)] = game_info.get('name', f"App {app_id}")
                page += 1
                time.sleep(1.5)
            else:
                print(f"[Wishlist] HTTP Status {res.status_code} alla pagina {page}")
                break
        except Exception as e:
            print(f"[Wishlist] Errore durante il recupero (pagina {page}): {e}")
            break
            
    return wishlist_games

def fetch_steam_info(app_id):
    url = f"https://store.steampowered.com/api/appdetails?appids={app_id}&cc=IT&l=italian&filters=price_overview,release_date,basic"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://store.steampowered.com/',
        'Cookie': 'wants_mature_content=1; birthtime=0; lastagecheckage=1-0-1990; timezoneOffset=3600,0'
    }
    
    for attempt in range(3):
        try:
            res = requests.get(url, headers=headers, timeout=12)
            if res.status_code == 200:
                json_data = res.json()
                app_data = json_data.get(str(app_id), {})
                
                if app_data.get('success') and 'data' in app_data:
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
    try:
        with open('games.json', 'r', encoding='utf-8') as f:
            games = json.load(f)
    except Exception:
        games = []

    existing_ids = {g['id'] for g in games}

    print(f"Sincronizzazione Wishlist per Steam ID: {STEAM_ID}...")
    wishlist = fetch_wishlist_games(STEAM_ID)
    
    new_count = 0
    for app_id, title in wishlist.items():
        if app_id not in existing_ids:
            games.append({
                "id": app_id,
                "title": title,
                "hype": 3
            })
            existing_ids.add(app_id)
            new_count += 1
            
    print(f"Wishlist letta ({len(wishlist)} giochi trovati, {new_count} nuovi aggiunti).")

    for game in games:
        print(f"Aggiornamento: {game.get('title')} ({game.get('id')})")
        info = fetch_steam_info(game['id'])
        game['status'] = info['status']
        game['price'] = info['price']
        game['discount'] = info['discount']
        time.sleep(2)

    with open('games.json', 'w', encoding='utf-8') as f:
        json.dump(games, f, indent=2, ensure_ascii=False)

if __name__ == '__main__':
    main()
