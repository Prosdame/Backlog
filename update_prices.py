import json
import re
import time
import requests

STEAM_ID = "76561198836972183"

def fetch_wishlist_games(steam_id):
    wishlist_games = {}
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
        'Cookie': 'wants_mature_content=1; birthtime=0; lastagecheckage=1-0-1990; timezoneOffset=3600,0'
    }
    
    # Metodo 1: Parsing diretto dell'HTML per aggirare il blocco API dei data center Cloud
    try:
        url_page = f"https://store.steampowered.com/wishlist/profiles/{steam_id}/"
        res_page = requests.get(url_page, headers=headers, timeout=12)
        if res_page.status_code == 200:
            html = res_page.text
            matches = re.findall(r'"appid"\s*:\s*(\d+)', html)
            if not matches:
                matches = re.findall(r'data-appid="(\d+)"', html)
            if not matches:
                matches = re.findall(r'/app/(\d+)', html)
                
            if matches:
                unique_ids = sorted(list(set(int(x) for x in matches)))
                print(f"[Wishlist HTML] Estratti {len(unique_ids)} ID dalla pagina.")
                for app_id in unique_ids:
                    wishlist_games[app_id] = f"App {app_id}"
                return wishlist_games
    except Exception as e:
        print(f"[Wishlist HTML Errore]: {e}")

    # Metodo 2: Endpoint API Wishlist Paginato (Fallback)
    page = 0
    headers_ajax = headers.copy()
    headers_ajax['Accept'] = 'application/json, text/javascript, */*; q=0.01'
    headers_ajax['X-Requested-With'] = 'XMLHttpRequest'
    headers_ajax['Referer'] = f'https://store.steampowered.com/wishlist/profiles/{steam_id}/'

    while True:
        url = f"https://store.steampowered.com/wishlist/profiles/{steam_id}/wishlistdata/?p={page}"
        try:
            res = requests.get(url, headers=headers_ajax, timeout=12)
            if res.status_code == 200:
                try:
                    data = res.json()
                except json.JSONDecodeError:
                    break
                    
                if not data or isinstance(data, list) or (isinstance(data, dict) and data.get("success") == 2):
                    break
                
                for app_id, game_info in data.items():
                    if isinstance(game_info, dict) and 'name' in game_info:
                        wishlist_games[int(app_id)] = game_info.get('name', f"App {app_id}")
                page += 1
                time.sleep(1.5)
            else:
                break
        except Exception as e:
            print(f"[Wishlist API Errore pagina {page}]: {e}")
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
                    title = g_data.get('name')
                    price_info = g_data.get('price_overview')
                    release_info = g_data.get('release_date', {})
                    
                    status = "N/D"
                    price = "N/D"
                    discount = "N/D"

                    if release_info.get('coming_soon'):
                        date_str = release_info.get('date', 'TBA')
                        status = f"Rilascio: {date_str}"
                    elif price_info:
                        price = f"€{price_info['final'] / 100:.2f}".replace('.', ',')
                        discount = f"{price_info['discount_percent']}%"
                        status = price
                    elif g_data.get('is_free'):
                        status = "Gratuito"
                        price = "€0,00"
                        discount = "0%"
                    else:
                        status = "Rilasciato (Prezzo N/D)"

                    return {"title": title, "status": status, "price": price, "discount": discount}
                else:
                    print(f"[Tentativo {attempt+1}] Steam success=false per ID {app_id}")
            else:
                print(f"[Tentativo {attempt+1}] HTTP status {res.status_code} per ID {app_id}")
        except Exception as e:
            print(f"[Tentativo {attempt+1}] Errore ID {app_id}: {e}")
        
        time.sleep(2)
        
    return {"title": None, "status": "Errore API", "price": "N/D", "discount": "N/D"}

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
    for app_id, default_title in wishlist.items():
        if app_id not in existing_ids:
            games.append({
                "id": app_id,
                "title": default_title,
                "hype": 3
            })
            existing_ids.add(app_id)
            new_count += 1
            
    print(f"Wishlist letta ({len(wishlist)} giochi trovati, {new_count} nuovi aggiunti).")

    for game in games:
        print(f"Aggiornamento: {game.get('title')} ({game.get('id')})")
        info = fetch_steam_info(game['id'])
        if info.get('title'):
            game['title'] = info['title']
        game['status'] = info['status']
        game['price'] = info['price']
        game['discount'] = info['discount']
        time.sleep(2)

    with open('games.json', 'w', encoding='utf-8') as f:
        json.dump(games, f, indent=2, ensure_ascii=False)

if __name__ == '__main__':
    main()
