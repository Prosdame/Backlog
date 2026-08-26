import json
import time
import requests

def fetch_steam_info(app_id):
    url = f"https://store.steampowered.com/api/appdetails?appids={app_id}&cc=it&l=it"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    try:
        res = requests.get(url, headers=headers, timeout=10)
        if res.status_code == 200:
            data = res.json().get(str(app_id), {})
            if data.get('success') and data.get('data'):
                g_data = data['data']
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
                    return {"status": "Gratuito / N/D", "price": "N/D", "discount": "N/D"}
    except Exception as e:
        print(f"Errore con ID {app_id}: {e}")
    return {"status": "Errore", "price": "N/D", "discount": "N/D"}

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