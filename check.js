const FIREBASE_URL = 'https://cyberpunk-2080-calendar-default-rtdb.europe-west1.firebasedatabase.app';
const COOLDOWN_MS = 20 * 60 * 1000;
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
  if(!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
}

async function main(){
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

  const data = (await getJSON('data')) || {};
  const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, tänään

  const counted = Object.keys(data)
    .filter(key => key >= todayKey) // jätä menneet päivät pois laskennasta
    .map(key => ({
      key,
      count: Object.values(data[key]).filter(status => status === 'vapaa').length
    })).filter(d => d.count > 0);

  counted.sort((a, b) => b.count - a.count);
  const total = counted.length;
  const top10 = counted.slice(0, 10);
  const listText = top10.map(d => `${formatDate(d.key)} — ${d.count} pelaajaa`).join('\n');
  const maxCount = counted.length ? counted[0].count : 0;
  const winners = counted.filter(d => d.count === maxCount && maxCount >= 6);

  if(maxCount >= 6){
    const announced = (await getJSON('ilmoitetut')) || {};
    const uusiPaiva = winners.find(w => !announced[w.key]);
    await sendWebhook(AIKATAULU_WEBHOOK,
      `LISTEN LISTEN LISTEN! Mi swear pon Jah, *${lastEditor}* kävi taas tekemässä merkintöjä to DE CALENDAR!\nMahdollisia pelipäiviä: ${total}\n\n${listText}`);
    if(uusiPaiva){
      await sendWebhook(ANNOUNCE_WEBHOOK, `Huomio huomio meillä on yhteinen pelipäivä! Clench your butcheeks and hold your Neurallinks....KOHTA MENNÄÄN!\n${CALENDAR_LINK}`);
      await putJSON(`ilmoitetut/${uusiPaiva.key}`, true);
    }
  } else if(maxCount === 5){
    await sendWebhook(AIKATAULU_WEBHOOK,
      `BOMBOCLAAAT! *${lastEditor}* kävi tekemässä merkintöjä to DE CALENDAR, mi seh!\nMahdollisia pelipäiviä: ${total}\n\n${listText}\n\nR WI GONNA PELAA SOON, RASTA?`);
  } else {
    await sendWebhook(AIKATAULU_WEBHOOK,
      `MASSIIVE NEWS, seen? *${lastEditor}* kävi tekemässä merkintöjä to DE CALENDAR!\nMahdollisia pelipäiviä: ${total}\n\n${listText}`);
  }

  await putJSON('meta/last_notified_edit_time', lastEditTime);
}

main().catch(err => { console.error(err); process.exit(1); });
