// ============================================================
// KALENTERIN TARKISTUSSKRIPTI — täysin uudelleenrakennettu versio
// ============================================================

const FIREBASE_URL = 'https://cyberpunk-2080-calendar-default-rtdb.europe-west1.firebasedatabase.app';
const CALENDAR_LINK = 'https://cyberpunk2080phantomstatic.netlify.app/';

const COOLDOWN_MS = 10 * 60 * 1000;              // 10 min viimeisimmästä muokkauksesta ennen recapia
const REMINDER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 päivää muistutusten välissä
const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;       // 3 päivän hiljaisuus pelatun päivän jälkeen
const MIN_VAPAA_RECAP = 4;                       // recapin "mahdollinen pelipäivä" -kynnys

const AIKATAULU_WEBHOOK = process.env.DISCORD_WEBHOOK_AIKATAULU;
const ANNOUNCE_WEBHOOK = process.env.DISCORD_WEBHOOK_ANNOUNCE;

// ---------- apufunktiot ----------

function formatDate(key){
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

function tanaanKey(){
  return new Date().toISOString().slice(0, 10);
}

async function getJSON(path){
  const res = await fetch(`${FIREBASE_URL}/${path}.json`);
  return await res.json();
}

async function putJSON(path, value){
  await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'PUT', body: JSON.stringify(value) });
}

async function sendWebhook(url, content){
  if(!url){
    console.log('VIRHE: webhook-URL puuttuu (secret on tyhjä tai nimi väärin kytketty).');
    return;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  if(!res.ok){
    const text = await res.text();
    console.log(`VIRHE: Discord hylkäsi viestin. Status ${res.status}: ${text}`);
  } else {
    console.log('Webhook lähetetty onnistuneesti.');
  }
}

// Palauttaa jokaisesta tulevasta päivästä vapaa/varattu-laskennat
function analysoiPaivat(data){
  const tanaan = tanaanKey();
  return Object.keys(data)
    .filter(key => key >= tanaan)
    .map(key => {
      const entries = Object.values(data[key]);
      return {
        key,
        vapaa: entries.filter(s => s === 'vapaa').length,
        varattu: entries.filter(s => s === 'varattu').length
      };
    });
}

function parhaatPaivat(paivat, minVapaa){
  return paivat
    .filter(d => d.vapaa >= minVapaa && d.varattu === 0)
    .sort((a, b) => b.vapaa - a.vapaa);
}

function muotoileLista(paivat){
  if(!paivat.length) return null;
  return paivat.map(d => `${formatDate(d.key)} — ${d.vapaa} pelaajaa`).join('\n');
}

// ---------- muistutus ----------

async function ajaMuistutus(paivat){
  const maxVapaa = paivat.reduce((max, d) => (d.varattu === 0 ? Math.max(max, d.vapaa) : max), 0);
  if(maxVapaa >= 6){
    console.log('Muistutusta ei tarvita, sopiva päivä on jo löytynyt.');
    return;
  }

  const tanaan = tanaanKey();
  const announced = (await getJSON('ilmoitetut')) || {};
  const menneetPelatut = Object.keys(announced).filter(key => key < tanaan).sort();

  if(menneetPelatut.length){
    const viimeisin = menneetPelatut[menneetPelatut.length - 1];
    const paiviaSitten = (Date.now() - new Date(viimeisin + 'T00:00:00Z').getTime()) / (24 * 60 * 60 * 1000);
    if(paiviaSitten < 3){
      console.log(`Edellisestä pelipäivästä (${viimeisin}) alle 3 päivää, ei muistuteta vielä.`);
      return;
    }
  }

  const lastReminder = await getJSON('meta/last_reminder_time');
  const now = Date.now();
  if(lastReminder && (now - lastReminder) < REMINDER_INTERVAL_MS){
    console.log(`Muistutuksesta on ${Math.round((now - lastReminder) / 3600000)}h, ei vielä 72h.`);
    return;
  }

  const viesti = 'Muistutus: käykää merkitsemässä oma saatavuutenne kalenteriin, jotta löydetään yhteinen pelipäivä!';
  await sendWebhook(AIKATAULU_WEBHOOK, `*${viesti}*\n\n${CALENDAR_LINK}`);
  await putJSON('meta/last_reminder_time', now);
}

// ---------- muokkauspohjainen recap ----------

async function ajaRecap(paivat, data){
  const lastEditTime = await getJSON('meta/last_edit_time');
  const lastEditor = await getJSON('meta/last_editor');
  const lastNotified = await getJSON('meta/last_notified_edit_time');

  if(!lastEditTime){ console.log('Ei muokkauksia vielä.'); return; }
  if(lastNotified === lastEditTime){ console.log('Tämä muokkauserä on jo ilmoitettu.'); return; }

  const elapsed = Date.now() - lastEditTime;
  if(elapsed < COOLDOWN_MS){
    console.log(`Cooldown kesken (${Math.round(elapsed / 1000)}s / ${COOLDOWN_MS / 1000}s).`);
    return;
  }

  if(Object.keys(data).length === 0){
    console.log('Kalenterissa ei ole yhtään merkintää, ei lähetetä recapia.');
    await putJSON('meta/last_notified_edit_time', lastEditTime);
    return;
  }

  const parhaat = parhaatPaivat(paivat, MIN_VAPAA_RECAP);
  const total = parhaat.length;

  if(total === 0){
    console.log('Ei yhtään sopivaa päivää, ei lähetetä recapia.');
    await putJSON('meta/last_notified_edit_time', lastEditTime);
    return;
  }

  const listText = muotoileLista(parhaat.slice(0, 10));
  const maxCount = parhaat[0].vapaa;

  if(maxCount < 6){
    await sendWebhook(AIKATAULU_WEBHOOK,
      `*${lastEditor} kävi tekemässä merkintöjä kalenteriin!\n\nMahdollisia pelipäiviä: ${total}\n\n${listText}*\n\n${CALENDAR_LINK}`);
  }

  if(maxCount >= 6){
    const announced = (await getJSON('ilmoitetut')) || {};
    const uusiPaiva = parhaat.find(d => d.vapaa === maxCount && !announced[d.key]);
    if(uusiPaiva){
      await sendWebhook(ANNOUNCE_WEBHOOK,
        `Huomio huomio meillä on yhteinen pelipäivä! Clench your butcheeks and hold your Neurallinks....KOHTA MENNÄÄN!\n\n${CALENDAR_LINK}`);
      await putJSON(`ilmoitetut/${uusiPaiva.key}`, true);
    }
  }

  await putJSON('meta/last_notified_edit_time', lastEditTime);
}

// ---------- pääohjelma ----------

async function main(){
  console.log('VERSIO: rehaul-1');

  const data = (await getJSON('data')) || {};
  const paivat = analysoiPaivat(data);

  await ajaMuistutus(paivat);
  await ajaRecap(paivat, data);
}

main().catch(err => { console.error(err); process.exit(1); });
