const FIREBASE_URL = 'https://cyberpunk-2080-calendar-default-rtdb.europe-west1.firebasedatabase.app';
const COOLDOWN_MS = 0;//20 * 60 * 1000;
const REMINDER_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 päivää
const CALENDAR_LINK = 'https://cyberpunk2080phantomstatic.netlify.app/';

const AIKATAULU_WEBHOOK = process.env.DISCORD_WEBHOOK_AIKATAULU;
const ANNOUNCE_WEBHOOK = process.env.DISCORD_WEBHOOK_ANNOUNCE;

function formatDate(key){
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

async function getJSON(path){
  const res = await fetch(`${FIREBASE_URL}/${path}.json`);
  return await res.json();
}
async function putJSON(path, value){
  await fetch(`${FIREBASE_URL}/${path}.json`, { method: 'PUT', body: JSON.stringify(value) });
}
async function sendWebhook(url, content){
  if(!url){ console.log('VIRHE: webhook-URL puuttuu (secret on tyhjä tai nimi väärin kytketty).'); return; }
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

function lahimmatPaivat(data, vahintaanVapaana){
  const todayKey = new Date().toISOString().slice(0, 10);
  const paivat = Object.keys(data)
    .filter(key => key >= todayKey)
    .map(key => {
      const entries = Object.values(data[key]);
      const vapaaCount = entries.filter(status => status === 'vapaa').length;
      const varattuCount = entries.filter(status => status === 'varattu').length;
      return { key, count: vapaaCount, varattuCount };
    })
    .filter(d => d.count >= vahintaanVapaana && d.varattuCount === 0);

  paivat.sort((a, b) => a.key.localeCompare(b.key)); // lähimmät (aikaisin päivämäärä) ensin
  return paivat.slice(0, 3);
}

function laskePaivat(data){
  const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, tänään
  const counted = Object.keys(data)
    .filter(key => key >= todayKey) // jätä menneet päivät pois laskennasta
    .map(key => {
      const entries = Object.values(data[key]);
      const vapaaCount = entries.filter(status => status === 'vapaa').length;
      const varattuCount = entries.filter(status => status === 'varattu').length;
      return { key, count: vapaaCount, varattuCount };
    })
    .filter(d => d.count >= 4 && d.varattuCount === 0); // vähintään 4 vapaana, ei yhtään varattua

  counted.sort((a, b) => b.count - a.count);
  const total = counted.length;
  const listText = counted.slice(0, 10).map(d => `${formatDate(d.key)} — ${d.count} pelaajaa`).join('\n')
    || 'Ei vielä yhtään sopivaa päivää.';
  const maxCount = counted.length ? counted[0].count : 0;
  return { counted, total, listText, maxCount };
}

async function tarkistaMuistutus(maxCount, data){
  if(maxCount >= 6){
    console.log('Muistutusta ei tarvita, sopiva päivä on jo löytynyt.');
    return;
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  const announced = (await getJSON('ilmoitetut')) || {};
  const menneetPelatut = Object.keys(announced).filter(key => key < todayKey).sort();

  if(menneetPelatut.length){
    const viimeisinPelattu = menneetPelatut[menneetPelatut.length - 1];
    const paiviaSitten = (Date.now() - new Date(viimeisinPelattu + 'T00:00:00Z').getTime()) / (24 * 60 * 60 * 1000);
    if(paiviaSitten < 3){
      console.log(`Edellisestä pelipäivästä (${viimeisinPelattu}) alle 3 päivää, ei muistuteta vielä.`);
      return;
    }
  }

  const lastReminder = await getJSON('meta/last_reminder_time');
  const now = Date.now();
  if(!lastReminder || (now - lastReminder) >= REMINDER_INTERVAL_MS){
    let viesti = 'Muistutus: käykää merkitsemässä oma saatavuutenne kalenteriin, jotta löydetään yhteinen pelipäivä!';
    const lahimmat = lahimmatPaivat(data, 2);
    if(lahimmat.length){
      const lista = lahimmat.map(d => `${formatDate(d.key)} — ${d.count} pelaajaa`).join('\n');
      viesti += `\n\nLähimmät mahdolliset päivät:\n${lista}`;
    }
    await sendWebhook(AIKATAULU_WEBHOOK, `*${viesti}*\n\n${CALENDAR_LINK}`);
    await putJSON('meta/last_reminder_time', now);
  } else {
    console.log(`Muistutuksesta on ${Math.round((now-lastReminder)/1000/60/60)}h, ei vielä 72h.`);
  }
}

async function main(){
  console.log('VERSIO: 2026-09-09-v4 (lähimmät päivät + tyhjän listan korjaus)');
  const data = (await getJSON('data')) || {};
  const { counted, total, listText, maxCount } = laskePaivat(data);

  await tarkistaMuistutus(maxCount, data);

  const lastEditTime = await getJSON('meta/last_edit_time');
  const lastEditor = await getJSON('meta/last_editor');
  const lastNotified = await getJSON('meta/last_notified_edit_time');

  if(!lastEditTime){ console.log('Ei muokkauksia vielä.'); return; }
  if(lastNotified === lastEditTime){ console.log('Tämä muokkauserä on jo ilmoitettu.'); return; }

  const elapsed = Date.now() - lastEditTime;
  if(elapsed < COOLDOWN_MS){
    console.log(`Cooldown kesken (${Math.round(elapsed/1000)}s / ${COOLDOWN_MS/1000}s).`);
    return;
  }

  if(Object.keys(data).length === 0){
    console.log('Kalenterissa ei ole yhtään merkintää, ei lähetetä recapia.');
    await putJSON('meta/last_notified_edit_time', lastEditTime);
    return;
  }

  const winners = counted.filter(d => d.count === maxCount && maxCount >= 6);

  if(maxCount >= 6){
    const announced = (await getJSON('ilmoitetut')) || {};
    const uusiPaiva = winners.find(w => !announced[w.key]);
    await sendWebhook(AIKATAULU_WEBHOOK,
      `*${lastEditor} kävi tekemässä merkintöjä kalenteriin!\nMahdollisia pelipäiviä: ${total}\n\n${listText}\n\nNyt näyttää siltä, että saadaan yhteinen pelipäivä!*\n\n${CALENDAR_LINK}`);
    if(uusiPaiva){
      await sendWebhook(ANNOUNCE_WEBHOOK, `Huomio huomio meillä on yhteinen pelipäivä! Clench your butcheeks and hold your Neurallinks....KOHTA MENNÄÄN!\n\n${CALENDAR_LINK}`);
      await putJSON(`ilmoitetut/${uusiPaiva.key}`, true);
    }
  } else if(maxCount === 5){
    await sendWebhook(AIKATAULU_WEBHOOK,
      `*${lastEditor} kävi tekemässä merkintöjä kalenteriin!\nMahdollisia pelipäiviä: ${total}\n\n${listText}\n\nPäästäänkö me kohta pelaamaan?*\n\n${CALENDAR_LINK}`);
  } else {
    await sendWebhook(AIKATAULU_WEBHOOK,
      `*${lastEditor} kävi tekemässä merkintöjä kalenteriin!\nMahdollisia pelipäiviä: ${total}\n\n${listText}*\n\n${CALENDAR_LINK}`);
  }

  await putJSON('meta/last_notified_edit_time', lastEditTime);
}

main().catch(err => { console.error(err); process.exit(1); });
