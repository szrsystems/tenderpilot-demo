/* AIpályázó — template draft generator (fallback when the AI endpoint is
   unavailable). Moved out of portal.html unchanged; callers pass HTML-escaped
   grant and profile objects, so interpolated values are safe. */
const INDUSTRY_OPTS = [['IT','IT / Szoftverfejlesztés'],['HVAC','Épületgépészet / HVAC'],['Construction','Építőipar'],['Manufacturing','Gyártás'],['Healthcare','Egészségügy'],['Restaurant','Vendéglátás'],['Tourism','Turizmus'],['Agriculture','Mezőgazdaság'],['Retail','Kereskedelem'],['Education','Oktatás'],['General','Egyéb']];
const REV_OPTS = [['<50M','< 50 M Ft (mikro)'],['50M-200M','50 - 200 M Ft (kicsi)'],['200M-500M','200 - 500 M Ft'],['500M-1Mrd','500 M - 1 Mrd Ft'],['1Mrd-3Mrd','1 - 3 Mrd Ft'],['3Mrd-10Mrd','3 - 10 Mrd Ft'],['10Mrd+','10 Mrd Ft felett']];
function revenueLabel(val) { if (!val) return ''; const hit = REV_OPTS.find(([v]) => v === val); return hit ? hit[1] : val; }
function parseAmount(s) {
    if (!s || /^Díj|^Minősítés|^Hitel|hitel$/i.test(s)) return 0;
    const isEUR = s.includes('€');
    const huf = isEUR ? 400 : 1; // 1 EUR ≈ 400 HUF
    // Find all numeric tokens with their multipliers
    const matches = [...s.matchAll(/([\d.]+)\s*(Mrd|M|K)?/gi)];
    if (!matches.length) return 0;
    let max = 0;
    // Look ahead to find suffix even if it appears after second number
    const tail = s.match(/(Mrd|M|K)\s*(Ft|HUF|EUR)?\s*$/i);
    matches.forEach((m, i) => {
        const n = parseFloat(m[1]);
        if (isNaN(n)) return;
        let mult = m[2] || (tail ? tail[1] : '');
        mult = (mult || '').toLowerCase();
        let mv = 1;
        if (mult === 'mrd') mv = 1e9;
        else if (mult === 'm') mv = 1e6;
        else if (mult === 'k') mv = 1e3;
        const v = n * mv * huf;
        if (v > max) max = v;
    });
    return max;
}

function formatFt(v) {
    if (!v) return '0 Ft';
    if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace('.0','') + ' Mrd Ft';
    if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M Ft';
    return Math.round(v).toLocaleString('hu-HU') + ' Ft';
}

function dr_industryLabel(code) {
    const o = INDUSTRY_OPTS && INDUSTRY_OPTS.find(x => x[0] === code);
    return o ? o[1] : 'KKV';
}

// Plausible budget split + total derived from the grant amount range:
// 70% of the parsed maximum (in HUF) as a realistic project size.
function dr_budget(g) {
    const max = parseAmount(g.amount) || 10000000;
    // Use 70% of max as a realistic project size
    const total = Math.round(max * 0.7);
    const cats = (g.cat || '').toLowerCase();
    let split;
    if (/digit|kutat|innov/.test(cats)) {
        split = [['Szoftver- és technológiabeszerzés', 0.35],['Fejlesztői és tanácsadói szolgáltatás', 0.30],['Eszköz- és hardverbeszerzés', 0.15],['Bér + járulékok', 0.12],['Általános és projekt-menedzsment', 0.08]];
    } else if (/energi|környezet/.test(cats)) {
        split = [['Eszköz- és technológiabeszerzés (megújuló/energetikai)', 0.55],['Építés és kivitelezés', 0.20],['Tervezés és műszaki szolgáltatás', 0.12],['Bér + járulékok', 0.08],['Általános költségek', 0.05]];
    } else if (/mező|agrár/.test(cats)) {
        split = [['Gép- és eszközbeszerzés', 0.45],['Tároló / üzemépület építése, felújítása', 0.30],['Telepítés és üzembe helyezés', 0.10],['Bér + járulékok', 0.10],['Általános költségek', 0.05]];
    } else if (/turiz/.test(cats)) {
        split = [['Eszköz- és gépbeszerzés', 0.40],['Építés / felújítás', 0.30],['Marketing és kommunikáció', 0.10],['Bér + járulékok', 0.12],['Általános költségek', 0.08]];
    } else {
        split = [['Eszköz- és technológiabeszerzés', 0.45],['Immateriális javak (licenc, szabadalmi)', 0.15],['Tanácsadói és szakértői szolgáltatás', 0.18],['Bér + járulékok', 0.14],['Általános és projekt-menedzsment', 0.08]];
    }
    return { total, rows: split.map(([n,p]) => [n, Math.round(total*p), Math.round(p*100)]) };
}

function dr_indicators(g, profile) {
    const cat = (g.cat || '').toLowerCase();
    if (/digit/.test(cat)) return [
        ['Bevezetett digitális megoldások száma', '4 db'],
        ['Folyamatautomatizálás által megtakarított munkaóra / hó', '120 óra'],
        ['Új vagy fejlesztett digitális szolgáltatások száma', '2 db'],
        ['Felhasználói/ügyfél elégedettség (NPS) növekedése', '+15 pont']
    ];
    if (/kutat|innov/.test(cat)) return [
        ['Új vagy lényegesen javított termék/szolgáltatás', '1 db'],
        ['Bejelentett iparjogvédelmi oltalom', '1 db'],
        ['K+F munkahelyek létrehozása', '2 fő'],
        ['Piacra vitt prototípus / pilot', '1 db']
    ];
    if (/energi|környezet/.test(cat)) return [
        ['Éves energiafogyasztás csökkenése', '−25%'],
        ['CO₂-kibocsátás csökkenése (t/év)', '−12 t'],
        ['Termelt megújuló energia (kWh/év)', '85 000 kWh'],
        ['Megtérülési idő', '6 év']
    ];
    if (/turiz/.test(cat)) return [
        ['Új vendégéjszakák száma / év', '1 800 db'],
        ['Foglalási csatornák bővülése', '+3 csatorna'],
        ['Vendég-elégedettség (online átlag)', '4.6+ / 5'],
        ['Új munkahely', '2 fő']
    ];
    if (/mező|agrár/.test(cat)) return [
        ['Termelési kapacitás növekedése', '+25%'],
        ['Betakarítási / tárolási veszteség csökkenése', '−15%'],
        ['Új vagy korszerűsített gép/eszköz', '3 db'],
        ['Új munkahely', '1 fő']
    ];
    return [
        ['Új munkahelyek létrehozása', '2 fő'],
        ['Árbevétel-növekedés a projekt befejezésétől 3 éven belül', '+30%'],
        ['Új termékek / szolgáltatások bevezetése', '1 db'],
        ['Üzemi kapacitás növelése', '+20%']
    ];
}

function dr_section_summary(g, p) {
    const co = p.company || 'A Pályázó';
    const ind = dr_industryLabel(p.industry).toLowerCase();
    const loc = p.location || 'Magyarország';
    return `<p>A <b>${co}</b> (${ind}, ${loc}) a jelen pályázat keretében a <b>${g.title}</b> felhívás támogatásával egy ${g.cat.toLowerCase()} kategóriájú beruházást kíván megvalósítani. A projekt célja a vállalkozás kapacitásainak, hatékonyságának és piaci pozíciójának fenntartható növelése a felhívás céljaihoz illeszkedő tevékenységeken keresztül. A tervezett projekt teljes költsége és a támogatás aránya a felhívás keretösszegéhez igazodik (max. ${g.amount}), a beruházás befejezésére a benyújtási határidőt (${g.deadline}) követő 12–18 hónapon belül kerül sor.</p>`;
}

function dr_section_applicant(g, p) {
    const co = p.company || 'A Pályázó';
    const ind = dr_industryLabel(p.industry).toLowerCase();
    const emp = p.employees || '11-25';
    const rev = revenueLabel(p.revenue) || '200 - 500 M Ft';
    const loc = p.location || 'Magyarország';
    const yr = (p.past_grants === 'won') ? ' és korábban már sikeresen pályázott hazai támogatásra' : '';
    return `<p>A(z) <b>${co}</b> magyarországi székhelyű, <b>${ind}</b> területén működő kis- és középvállalkozás (létszám: ${emp} fő, éves árbevétel: ${rev})${yr}. Székhelye: ${loc}. A vállalkozás stabil piaci jelenléttel, kiépített vevőkörrel és működő üzleti modellel rendelkezik, így a jelen pályázati projekt által célzott fejlesztések szilárd alapra építhetők.</p>
<p>A Pályázó megfelel a KKV-kritériumoknak (2003/361/EK ajánlás szerint), nyilatkozat szerint köztartozásmentes, és vállalja a felhívásban meghatározott horizontális és fenntarthatósági követelmények teljesítését. A projekt megvalósításához szükséges saját erő, illetve áthidaló finanszírozási háttér biztosított.</p>
<p>A Pályázó a projektet a saját szervezetén belül, kiegészítő külső szakértői támogatással valósítja meg; a beszerzések a felhívás szerinti — minimum három független árajánlat alapján — piaci áron történnek.</p>`;
}

function dr_section_goals(g, p) {
    const cat = (g.cat || '').toLowerCase();
    let body = '';
    if (/digit/.test(cat)) {
        body = `<p>A projekt elsődleges célja a Pályázó működésének <b>digitális transzformációja</b>: a manuális, papír- és e-mail alapú folyamatok automatizálása, integrált üzleti rendszer bevezetése, valamint adat-alapú vezetői döntéshozatal megalapozása. A digitális érettségi szint emelése közvetlen versenyelőnyt biztosít az iparágon belül.</p>
<p>A projekt indokoltsága a Pályázó jelenlegi folyamatainak hatékonysági korlátaiban gyökerezik. Az adatok széttagoltsága, a párhuzamos manuális adatrögzítés és a riportálás lassúsága jelentős — közvetlenül mérhető — időveszteséget okoz. A pályázati projekt ezeknek a fájdalompontoknak a célzott megszüntetésére irányul.</p>`;
    } else if (/kutat|innov/.test(cat)) {
        body = `<p>A projekt célja egy <b>új vagy lényegesen javított termék/szolgáltatás</b> kifejlesztése és piaci bevezetésre való előkészítése. A fejlesztés a hazai és nemzetközi piaci igények dokumentált hiányosságaira válaszol, és piaci szempontból fenntartható megoldást kínál.</p>
<p>Az innovációs projekt a Pályázó belső szakmai kompetenciáira és külső kutatási partnerre épül, biztosítva a tudományos megalapozottságot és a piaci relevanciát egyaránt. A projekt eredménye iparjogvédelmi oltalom megszerzésével védhető.</p>`;
    } else if (/energi|környezet/.test(cat)) {
        body = `<p>A projekt célja a Pályázó működésének <b>energiahatékonyabbá tétele</b> és a megújuló energiaforrások részarányának növelése. A beruházás eredményeként mérséklődik a fosszilis energiahordozóktól való függés, csökken az üzemeltetési költség, és javul a vállalkozás karbonlábnyoma.</p>
<p>A projekt indokoltságát az utóbbi évek energiaár-volatilitása és a fenntarthatósági szabályozási környezet szigorodása adja. A beruházás 5–8 éves megtérülési idővel, mérhető környezeti hatással jár.</p>`;
    } else if (/turiz/.test(cat)) {
        body = `<p>A projekt célja a Pályázó turisztikai szolgáltatás-portfóliójának <b>minőségi és kapacitásbeli</b> fejlesztése. A fejlesztés egyszerre szolgálja a vendég-élmény javítását, a foglaltság növelését az alacsony szezonban, és a hosszabb tartózkodási idő ösztönzését.</p>
<p>A magyar belföldi és nemzetközi turisztikai kereslet növekvő trendje, valamint a régió turisztikai stratégiájával való szinergia indokolja a beruházást.</p>`;
    } else if (/mező|agrár/.test(cat)) {
        body = `<p>A projekt célja a Pályázó <b>mezőgazdasági termelési kapacitásának és hatékonyságának</b> fejlesztése korszerű gép- és eszközpark beszerzésével, valamint a tárolási/feldolgozási kapacitás bővítésével. A beruházás csökkenti a kézi munka arányát, mérsékli a betakarítási és tárolási veszteséget, és javítja a termékminőséget.</p>
<p>A projekt indokoltságát az elavult eszközpark, a növekvő munkaerőköltség és a piac szigorodó minőségi elvárásai adják. A felhívás kedvező finanszírozási feltételei mellett a beruházás megtérülése jelentősen rövidebb a támogatás nélkül elérhetőnél.</p>`;
    } else {
        body = `<p>A projekt célja a Pályázó <b>termelői/szolgáltatási kapacitásainak és versenyképességének</b> mérhető növelése a felhívás keretrendszerén belül. A beruházás közvetlenül érinti a Pályázó működésének értékteremtő mag-folyamatait.</p>
<p>A projekt indokoltságát a Pályázó kapacitás-korlátai, a növekvő piaci kereslet, valamint a jelenlegi eszközpark elavultsága adja. A beruházás megtérülése a felhívás által támogatott kedvező finanszírozási feltételek mellett a támogatás nélkül elérhetőnél jelentősen rövidebb.</p>`;
    }
    return body;
}

function dr_section_activities(g, p) {
    const ideas = (typeof fundingIdeas === 'function') ? fundingIdeas(g) : [];
    if (!ideas.length) return '<p>A projekt keretében a felhívás által támogatott elszámolható tevékenységek valósulnak meg.</p>';
    return `<p>A projekt az alábbi fő tevékenységi csomagokon keresztül valósul meg:</p>
<ul>${ideas.map(([ic, t]) => `<li><b>${t.split(' — ')[0]}</b> — ${(t.split(' — ')[1] || '')}</li>`).join('')}</ul>
<p>A tevékenységek a felhívás elszámolható költség-kategóriáira illeszkednek, és a beszerzések a hatályos magyar pályázati eljárásrend szerint (minimum 3 árajánlat, piaci ár, dokumentált indokolás) történnek.</p>`;
}

function dr_section_indicators(g, p) {
    const rows = dr_indicators(g, p);
    return `<p>A projekt által vállalt indikátorok és számszerűsített eredmények:</p>
<table><thead><tr><th>Indikátor</th><th>Vállalt érték (projekt végére)</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r[0]}</td><td><b>${r[1]}</b></td></tr>`).join('')}</tbody></table>`;
}

function dr_section_budget(g, p) {
    const b = dr_budget(g);
    const fmt = (n) => n.toLocaleString('hu-HU') + ' Ft';
    return `<p>A projekt tervezett teljes költségvetése: <b>${fmt(b.total)}</b>. A költségek a felhívás elszámolható kategóriáira oszlanak az alábbiak szerint:</p>
<table><thead><tr><th>Költségkategória</th><th>Összeg</th><th>%</th></tr></thead><tbody>${b.rows.map(r=>`<tr><td>${r[0]}</td><td>${fmt(r[1])}</td><td>${r[2]}%</td></tr>`).join('')}<tr><td><b>Összesen</b></td><td><b>${fmt(b.total)}</b></td><td><b>100%</b></td></tr></tbody></table>
<p style="font-size:12px;color:var(--gray-500);">A költségvetés tervezet — a végleges összegek a felhívás elszámolhatósági szabályai, a 3 árajánlatos eljárás eredménye és a pályázatírói véglegesítés után konkretizálódnak.</p>`;
}

function dr_section_timeline(g, p) {
    return `<p>A projekt 12 hónapos megvalósítási időszakra tervezett. Kezdés a támogatói okirat aláírását követő 30 napon belül.</p>
<table><thead><tr><th>Negyedév</th><th>Mérföldkő</th></tr></thead><tbody>
<tr><td>1. negyedév</td><td>Projekt indítása, beszerzési eljárások (3 árajánlat), szerződéskötések</td></tr>
<tr><td>2. negyedév</td><td>Eszközök/szolgáltatások szállítása, telepítés, alaprendszerek bevezetése</td></tr>
<tr><td>3. negyedév</td><td>Integráció, felhasználói képzés, tesztüzem</td></tr>
<tr><td>4. negyedév</td><td>Éles üzem, indikátor-mérés, projekt-zárás, kifizetési kérelem benyújtása</td></tr>
</tbody></table>`;
}

function dr_section_sustainability(g, p) {
    return `<p>A Pályázó vállalja, hogy a projekt eredményeit a felhívásban előírt — jellemzően 3 éves — fenntartási időszakban folyamatosan üzemelteti, az indikátorokat fenntartja, és az ellenőrzéshez szükséges dokumentációt megőrzi. A beruházás eredményei beépülnek a vállalkozás működési modelljébe, így a fenntartás nem külön költség, hanem az új, hatékonyabb működés természetes része.</p>`;
}

function dr_section_risks(g, p) {
    return `<p>A főbb azonosított kockázatok és a tervezett kezelésük:</p>
<table><thead><tr><th>Kockázat</th><th>Valószínűség</th><th>Kezelés</th></tr></thead><tbody>
<tr><td>Beszállítói késedelem</td><td>Közepes</td><td>3 független árajánlat, kötbéres szerződés, tartalék-szállító azonosítása</td></tr>
<tr><td>Költségváltozás (infláció, devizaárfolyam)</td><td>Közepes</td><td>Időben rögzített árak, projekt-tartalék elkülönítése</td></tr>
<tr><td>Felhasználói ellenállás (új folyamatok)</td><td>Alacsony</td><td>Korai bevonás, lépcsőzetes bevezetés, célzott képzés</td></tr>
<tr><td>Indikátor-elmaradás</td><td>Alacsony</td><td>Negyedéves mérés, korai beavatkozás, mérési módszertan rögzítése</td></tr>
</tbody></table>`;
}

