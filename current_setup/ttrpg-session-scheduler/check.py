#!/usr/bin/env python3
# ============================================================
# KALENTERIN TARKISTUSSKRIPTI — Python-versio vanhalle Raspberry Pille
# (sama logiikka kuin check.js, ei tarvitse Node.js:ää eikä Dockeria)
# ============================================================

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

FIREBASE_URL = 'https://YOUR_PROJECT-default-rtdb.YOUR_REGION.firebasedatabase.app'
CALENDAR_LINK = 'https://YOUR_SITE.netlify.app/'

COOLDOWN_MS = 15 * 60 * 1000               # 15 min viimeisimmästä muokkauksesta ennen recapia
REMINDER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000  # 3 päivää muistutusten välissä
MIN_VAPAA_RECAP = 4                        # recapin "mahdollinen pelipäivä" -kynnys

AIKATAULU_WEBHOOK = os.environ.get('DISCORD_WEBHOOK_AIKATAULU')
ANNOUNCE_WEBHOOK = os.environ.get('DISCORD_WEBHOOK_ANNOUNCE')


def format_date(key):
    y, m, d = key.split('-')
    return f'{d}.{m}.{y}'


def tanaan_key():
    return datetime.now(timezone.utc).strftime('%Y-%m-%d')


def now_ms():
    return int(time.time() * 1000)


HEADERS_JSON = {'Content-Type': 'application/json', 'User-Agent': 'KalenteriBotti/1.0 (Raspberry Pi cron script)'}


def get_json(path):
    url = f'{FIREBASE_URL}/{path}.json'
    req = urllib.request.Request(url, headers={'User-Agent': HEADERS_JSON['User-Agent']})
    with urllib.request.urlopen(req, timeout=15) as res:
        raw = res.read().decode('utf-8')
        return json.loads(raw) if raw != 'null' else None


def put_json(path, value):
    url = f'{FIREBASE_URL}/{path}.json'
    data = json.dumps(value).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='PUT', headers=HEADERS_JSON)
    with urllib.request.urlopen(req, timeout=15):
        pass


def send_webhook(url, content):
    if not url:
        print('VIRHE: webhook-URL puuttuu (ympäristömuuttuja on tyhjä tai nimi väärin).')
        return
    data = json.dumps({'content': content}).encode('utf-8')
    req = urllib.request.Request(url, data=data, method='POST', headers=HEADERS_JSON)
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            if res.status < 200 or res.status >= 300:
                print(f'VIRHE: Discord hylkäsi viestin. Status {res.status}')
            else:
                print('Webhook lähetetty onnistuneesti.')
    except urllib.error.HTTPError as e:
        print(f'VIRHE: Discord hylkäsi viestin. Status {e.code}: {e.read().decode("utf-8", "ignore")}')


def analysoi_paivat(data):
    tanaan = tanaan_key()
    paivat = []
    for key, entries in (data or {}).items():
        if key < tanaan:
            continue
        if isinstance(entries, dict):
            values = list(entries.values())
        elif isinstance(entries, list):
            # Firebase muuttaa peräkkäiset numeeriset avaimet (esim. "1","2","3")
            # automaattisesti JSON-listaksi objektin sijaan.
            values = [v for v in entries if v is not None]
        else:
            values = []
        paivat.append({
            'key': key,
            'vapaa': values.count('vapaa'),
            'varattu': values.count('varattu')
        })
    return paivat


def parhaat_paivat(paivat, min_vapaa):
    ehdokkaat = [d for d in paivat if d['vapaa'] >= min_vapaa and d['varattu'] == 0]
    ehdokkaat.sort(key=lambda d: d['vapaa'], reverse=True)
    return ehdokkaat


def muotoile_lista(paivat):
    if not paivat:
        return None
    return '\n'.join(f"{format_date(d['key'])} — {d['vapaa']} pelaajaa" for d in paivat)


def aja_muistutus(paivat):
    max_vapaa = max([d['vapaa'] for d in paivat if d['varattu'] == 0], default=0)
    if max_vapaa >= 6:
        print('Muistutusta ei tarvita, sopiva päivä on jo löytynyt.')
        return

    tanaan = tanaan_key()
    announced = get_json('ilmoitetut') or {}
    menneet_pelatut = sorted(k for k in announced.keys() if k < tanaan)

    if menneet_pelatut:
        viimeisin = menneet_pelatut[-1]
        viimeisin_dt = datetime.strptime(viimeisin, '%Y-%m-%d').replace(tzinfo=timezone.utc)
        paivia_sitten = (datetime.now(timezone.utc) - viimeisin_dt) / timedelta(days=1)
        if paivia_sitten < 3:
            print(f'Edellisestä pelipäivästä ({viimeisin}) alle 3 päivää, ei muistuteta vielä.')
            return

    last_reminder = get_json('meta/last_reminder_time')
    now = now_ms()
    if last_reminder and (now - last_reminder) < REMINDER_INTERVAL_MS:
        tunteja = round((now - last_reminder) / 3600000)
        print(f'Muistutuksesta on {tunteja}h, ei vielä 72h.')
        return

    viesti = 'Muistutus: käykää merkitsemässä oma saatavuutenne kalenteriin, jotta löydetään yhteinen pelipäivä!'
    send_webhook(AIKATAULU_WEBHOOK, f'*{viesti}*\n\n{CALENDAR_LINK}')
    put_json('meta/last_reminder_time', now)


def aja_recap(paivat, data):
    last_edit_time = get_json('meta/last_edit_time')
    last_editor = get_json('meta/last_editor')
    last_notified = get_json('meta/last_notified_edit_time')

    if not last_edit_time:
        print('Ei muokkauksia vielä.')
        return
    if last_notified == last_edit_time:
        print('Tämä muokkauserä on jo ilmoitettu.')
        return

    elapsed = now_ms() - last_edit_time
    if elapsed < COOLDOWN_MS:
        print(f'Cooldown kesken ({round(elapsed/1000)}s / {round(COOLDOWN_MS/1000)}s).')
        return

    if not data:
        print('Kalenterissa ei ole yhtään merkintää, ei lähetetä recapia.')
        put_json('meta/last_notified_edit_time', last_edit_time)
        return

    parhaat = parhaat_paivat(paivat, MIN_VAPAA_RECAP)
    total = len(parhaat)

    if total == 0:
        send_webhook(AIKATAULU_WEBHOOK,
            f'*{last_editor} kävi tekemässä merkintöjä, käy sinäkin!*\n\n{CALENDAR_LINK}')
        put_json('meta/last_notified_edit_time', last_edit_time)
        return

    list_text = muotoile_lista(parhaat[:10])
    max_count = parhaat[0]['vapaa']

    if max_count < 6:
        send_webhook(AIKATAULU_WEBHOOK,
            f'*{last_editor} kävi tekemässä merkintöjä kalenteriin!\n\n'
            f'Mahdollisia pelipäiviä: {total}\n\n{list_text}*\n\n{CALENDAR_LINK}')

    if max_count >= 6:
        announced = get_json('ilmoitetut') or {}
        uusi_paiva = next((d for d in parhaat if d['vapaa'] == max_count and not announced.get(d['key'])), None)
        if uusi_paiva:
            send_webhook(ANNOUNCE_WEBHOOK,
                'Huomio huomio meillä on yhteinen pelipäivä! Clench your butcheeks and hold your '
                f'Neurallinks....KOHTA MENNÄÄN!\n\n{CALENDAR_LINK}')
            put_json(f"ilmoitetut/{uusi_paiva['key']}", True)

    put_json('meta/last_notified_edit_time', last_edit_time)


def main():
    print('VERSIO: rasp-py-1')
    data = get_json('data') or {}
    paivat = analysoi_paivat(data)

    aja_muistutus(paivat)
    aja_recap(paivat, data)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'VIRHE: {e}', file=sys.stderr)
        sys.exit(1)
