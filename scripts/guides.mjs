// =========================================================================
// AIpályázó — evergreen guides (aipalyazo/utmutato/*.html)
// =========================================================================
// Short, sourced explainers for the questions companies (and AI assistants)
// ask about grants. Each guide answers first, links its official sources and
// pulls live numbers from the feed, so the page stays current every day.
// Facts here must come from the listed sources; when a rule depends on the
// call, say so instead of guessing.
// =========================================================================

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
const longDate = (d) => `${d.slice(0, 4)}. ${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}.`;
const grantish = (g) => /grant|wage/.test(g.type || '');
const loanish = (g) => /loan|guarantee/.test(g.type || '');
const sizes = (g) => g.sizeClasses || [];

export const GUIDES = [
  {
    slug: 'kkv-minosites',
    seoTitle: 'KKV-minősítés: mikro-, kis- és középvállalkozás határai',
    updated: '2026-10-13',
    title: 'Mikro-, kis- vagy középvállalkozás? A KKV-minősítés határai',
    description: 'Mikrovállalkozás: 10 főnél kevesebb, legfeljebb 2 millió euró árbevétel vagy mérlegfőösszeg. A kis- és középvállalkozás határai, kapcsolt cégek.',
    lead: 'Mikrovállalkozás az, ahol 10 főnél kevesebben dolgoznak, és az éves nettó árbevétel vagy a mérlegfőösszeg legfeljebb 2 millió euró. Kisvállalkozás: 50 főnél kevesebb és legfeljebb 10 millió euró. Középvállalkozás: 250 főnél kevesebb, és legfeljebb 50 millió euró árbevétel vagy legfeljebb 43 millió euró mérlegfőösszeg.',
    sections: [
      { h: 'A három kategória', html: `<table class="facts"><tr><th>Kategória</th><td><b>Létszám</b> · <b>árbevétel vagy mérlegfőösszeg</b></td></tr>
<tr><th>Mikrovállalkozás</th><td>10 főnél kevesebb · legfeljebb 2 millió euró</td></tr>
<tr><th>Kisvállalkozás</th><td>50 főnél kevesebb · legfeljebb 10 millió euró</td></tr>
<tr><th>Középvállalkozás</th><td>250 főnél kevesebb · árbevétel legfeljebb 50 millió euró, vagy mérlegfőösszeg legfeljebb 43 millió euró</td></tr></table>
<p>A létszámfeltételnek mindig teljesülnie kell; a pénzügyi feltételek közül elég az egyiknek (árbevétel <em>vagy</em> mérlegfőösszeg). Az euróban megadott határokat az üzleti év mérlegfordulónapján érvényes MNB-középárfolyamon kell forintra átszámítani.</p>` },
      { h: 'Mit kell beleszámolni?', html: `<ul><li><b>Kapcsolt vállalkozások</b> (például többségi tulajdonú leány- vagy anyavállalat) adatait teljes egészében hozzá kell adni.</li>
<li><b>Partnervállalkozások</b> adatait a tulajdoni vagy szavazati arány szerinti részükkel kell hozzáadni.</li>
<li>Ha az állam vagy önkormányzat közvetlenül vagy közvetve együtt <b>25%-nál nagyobb</b> tulajdoni részt vagy szavazati jogot birtokol, a cég nem KKV (a törvény néhány kivételt enged).</li>
<li>A legutolsó lezárt üzleti év (konszolidált) beszámolója számít. A minősítés csak akkor változik, ha a cég <b>két egymást követő évben</b> lépi át (vagy nem éri el) a határt.</li></ul>` },
      { h: 'Miért fontos a pályázatnál?', html: `<p>A legtöbb hazai felhívás megmondja, mely méretkategóriák pályázhatnak, és sokszor a támogatási intenzitás is a mérettől függ. A rossz kategória megadása az egyik leggyakoribb kizáró hiba, ezért beadás előtt érdemes a kapcsolt és partnercégekkel együtt kiszámolni.</p>` },
    ],
    live: (open, link) => {
      const hu = open.filter((g) => g.scope !== 'eu');
      const micro = hu.filter((g) => sizes(g).some((s) => s.startsWith('mikro'))).length;
      const nagy = hu.filter((g) => sizes(g).includes('nagyvállalkozás')).length;
      return `Jelenleg ${hu.length} nyitott hazai felhívás van; ebből ${micro} felhívásra mikrovállalkozás is pályázhat, ${nagy} felhívásra nagyvállalat is. Lásd: ${link('mikrovallalkozas', 'pályázatok mikrovállalkozásoknak')}, ${link('kkv', 'pályázatok KKV-knak')}.`;
    },
    faq: [
      { q: 'Hány fős cég számít mikrovállalkozásnak?', a: '10 főnél kevesebb foglalkoztatott, és legfeljebb 2 millió euró éves nettó árbevétel vagy mérlegfőösszeg.' },
      { q: 'Egyéni vállalkozó KKV-nak számít?', a: 'Igen, az egyéni vállalkozó is vállalkozás; a minősítése a foglalkoztatotti létszám és a bevételi adatai alapján történik, jellemzően mikrovállalkozás.' },
      { q: 'Mikor veszíti el egy cég a KKV-státuszát?', a: 'Ha két egymást követő lezárt üzleti évben átlépi a határokat, vagy ha az állami/önkormányzati tulajdon 25% fölé nő.' },
    ],
    sources: [
      ['2004. évi XXXIV. törvény a kis- és középvállalkozásokról (Nemzeti Jogszabálytár)', 'https://njt.jog.gov.hu/jogszabaly/2004-34-00-00'],
      ['NKFIH: Tájékoztató a KKV-minősítés megállapításához', 'https://nkfih.gov.hu/palyazoknak/nkfi-alap/palyazati-csomag/tajekoztato-kkv-minosites-megallapitasahoz'],
    ],
  },
  {
    slug: 'de-minimis-tamogatas',
    seoTitle: 'De minimis támogatás: 300 000 euró 3 év alatt',
    updated: '2026-10-13',
    title: 'Mi az a de minimis támogatás? 300 000 eurós keret három év alatt',
    description: 'A de minimis támogatás felső határa 2024 óta 300 000 euró vállalkozásonként, bármely három év alatt. Kire vonatkozik, mi a kivétel.',
    lead: 'A de minimis („csekély összegű”) támogatás olyan állami támogatás, amelyet az EU nem tekint versenytorzítónak, ezért egyszerűbb szabályokkal adható. 2024. január 1-jétől egy vállalkozás egy tagállamtól bármely három év alatt legfeljebb 300 000 euró de minimis támogatást kaphat (az (EU) 2023/2831 rendelet alapján).',
    sections: [
      { h: 'A legfontosabb szabályok', html: `<ul><li><b>Felső határ:</b> 300 000 euró egy vállalkozásnak, egy tagállamban, <b>gördülő három év</b> alatt (korábban 200 000 euró és három pénzügyi év volt).</li>
<li><b>Egy vállalkozás:</b> a kapcsolt cégek együtt számítanak, nem cégenként külön.</li>
<li><b>Időpont:</b> a támogatás akkor számít „megkapottnak”, amikor a cégnek jogosultsága keletkezik rá (pl. a támogatói okirat napján), nem a kifizetéskor.</li>
<li><b>Kivételek:</b> a mezőgazdasági termelésre, a halászatra és akvakultúrára külön (alacsonyabb keretű) de minimis szabályok vonatkoznak; exporttámogatásra nem adható.</li>
<li><b>Nyilvántartás:</b> 2026-tól a tagállamoknak nyilvános központi nyilvántartást kell vezetniük a de minimis támogatásokról.</li></ul>` },
      { h: 'Mit jelent ez a gyakorlatban?', html: `<p>Sok hazai felhívás (és a kedvezményes hitelek kamattámogatása is) de minimis alapon ad támogatást. Beadáskor nyilatkozni kell az elmúlt három évben kapott de minimis támogatásokról. Ha a cég már közel jár a 300 000 eurós határhoz, egy újabb támogatás elutasítható vagy csökkenthető, ezért érdemes előre összesíteni.</p>` },
    ],
    live: (open, link) => {
      const hu = open.filter((g) => g.scope !== 'eu').length;
      return `Jelenleg ${hu} nyitott hazai felhívás és hitel érhető el vállalkozásoknak. Hogy egy adott támogatás de minimis vagy más jogcímen jár, azt mindig a felhívás állami támogatási szabályokról szóló része mondja meg. Lásd: ${link('kkv', 'pályázatok KKV-knak')}, ${link('hitel', 'kedvezményes hitelek')}.`;
    },
    faq: [
      { q: 'Mennyi de minimis támogatást kaphat egy cég?', a: '2024. január 1-jétől egy vállalkozás (a kapcsolt cégekkel együtt) egy tagállamtól bármely három év alatt legfeljebb 300 000 eurót.' },
      { q: 'A de minimis keretbe a hitelek is beleszámítanak?', a: 'A kedvezményes kamatú hitelnek és a garanciának a támogatástartalma (az ún. bruttó támogatási egyenérték) számít bele, nem a teljes hitelösszeg.' },
      { q: 'Mezőgazdasági cégekre ugyanez vonatkozik?', a: 'Nem: a mezőgazdasági termelésre és a halászatra külön de minimis rendeletek és alacsonyabb keretek vonatkoznak.' },
    ],
    sources: [
      ['Az Európai Bizottság (EU) 2023/2831 rendelete (EUR-Lex)', 'https://eur-lex.europa.eu/eli/reg/2023/2831/oj'],
      ['CMS: Revision of the European rules applying to de minimis aid', 'https://cms.law/en/bel/legal-updates/revision-of-the-european-rules-applying-to-de-minimis-aid'],
    ],
  },
  {
    slug: 'vissza-nem-teritendo-vagy-hitel',
    seoTitle: 'Vissza nem térítendő támogatás vagy hitel?',
    updated: '2026-10-13',
    title: 'Vissza nem térítendő támogatás vagy kedvezményes hitel? A különbség',
    description: 'A vissza nem térítendő támogatást nem kell visszafizetni, a kedvezményes hitelt igen, de olcsóbban. Mikor melyik éri meg?',
    lead: 'A vissza nem térítendő támogatást nem kell visszafizetni, ha a cég a vállalt projektet a feltételek szerint megvalósítja; a kedvezményes hitelt vissza kell fizetni, de a piacinál alacsonyabb (akár 0%-os) kamattal. A kettő kombinálható is: a kombinált termékek egy része támogatás, a többi hitel.',
    sections: [
      { h: 'Röviden a formák', html: `<ul><li><b>Vissza nem térítendő támogatás:</b> pályázni kell, a támogatási intenzitás (például a költségek 50–70%-a) és az önerő a felhívástól függ. Jellemzően utólag, a költségek elszámolása után fizetik ki, egyes felhívásoknál előleggel.</li>
<li><b>Kedvezményes hitel:</b> banknál vagy hitelközvetítőnél igényelhető, folyamatosan, amíg a keret tart. Gyorsabb, de vissza kell fizetni, és fedezetet kérhetnek.</li>
<li><b>Kombinált hiteltermék:</b> egy projekten belül hitel és vissza nem térítendő rész együtt.</li>
<li><b>Garancia, kezességvállalás:</b> nem pénz, hanem biztosíték, amellyel könnyebb hitelt kapni.</li>
<li><b>Tőkebefektetés:</b> a befektető tulajdonrészt kap a cégben, nem hitel és nem támogatás.</li></ul>` },
      { h: 'Melyiket válassza?', html: `<p>Ha a projekt illeszkedik egy nyitott felhíváshoz és van idő a pályázatra, a vissza nem térítendő támogatás a legolcsóbb forrás. Ha gyorsan kell a pénz, vagy nincs megfelelő felhívás, a kedvezményes hitel a reálisabb. Sok cég a kettőt együtt használja: a támogatást kiegészíti hitellel az önerőhöz.</p>` },
    ],
    live: (open, link) => `Jelenleg ${open.filter(grantish).length} nyitott vissza nem térítendő támogatás és ${open.filter(loanish).length} kedvezményes hitel vagy garancia érhető el vállalkozásoknak. Lásd: ${link('vissza-nem-teritendo', 'vissza nem térítendő támogatások')}, ${link('hitel', 'kedvezményes hitelek és lízing')}, ${link('garancia', 'garancia')}.`,
    faq: [
      { q: 'Vissza kell fizetni a vissza nem térítendő támogatást?', a: 'Nem, ha a cég a projektet a támogatói okiratban vállalt feltételek szerint megvalósítja és fenntartja. Szabálytalanság esetén a támogatás visszakövetelhető.' },
      { q: 'Mikor kapom meg a pénzt?', a: 'A legtöbb felhívásnál a költségek elszámolása után (utófinanszírozás); egyes felhívások előleget is adnak. A pontos szabályt a felhívás tartalmazza.' },
      { q: 'Hol lehet kedvezményes hitelt igényelni?', a: 'Jellemzően a programban részt vevő kereskedelmi bankoknál, hitelközvetítőknél vagy az MFB Pontokon; az adott hitelprogram oldala felsorolja őket.' },
    ],
    sources: [
      ['palyazat.gov.hu — Széchenyi Terv Plusz felhívások', 'https://www.palyazat.gov.hu'],
      ['MFB — vállalkozói hitelprogramok', 'https://www.mfb.hu/vallalkozasok'],
    ],
  },
  {
    slug: 'hogyan-palyazzunk',
    seoTitle: 'Hogyan pályázzunk? A pályázás lépései',
    updated: '2026-10-13',
    title: 'Hogyan pályázzunk? A pályázás lépései vállalkozásoknak',
    description: 'A pályázás lépései: felhívás, jogosultság, költségvetés, elektronikus beadás a palyazat.gov.hu-n, hiánypótlás, döntés, elszámolás.',
    lead: 'A hazai pályázatokat elektronikusan, a palyazat.gov.hu E-ügyintézés felületén kell beadni. A folyamat: megfelelő felhívás kiválasztása → jogosultság ellenőrzése → projekt és költségvetés → kitöltés és mellékletek → elektronikus nyilatkozat hitelesítése és beadás → hiánypótlás → döntés → támogatói okirat → megvalósítás és elszámolás.',
    sections: [
      { h: 'A lépések', html: `<ol><li><b>Felhívás kiválasztása.</b> Nézze meg a nyitott felhívásokat, a határidőt és a még szabad keretet.</li>
<li><b>Jogosultság.</b> Cégméret (KKV-minősítés), székhely vagy telephely régiója, TEÁOR, lezárt üzleti évek, köztartozásmentesség, de minimis keret. Egyetlen nem teljesülő feltétel is kizáró lehet.</li>
<li><b>Projekt és költségvetés.</b> Csak a felhívásban elszámolhatónak jelölt költségek számítanak; árajánlatok kellenek.</li>
<li><b>Kitöltés.</b> A palyazat.gov.hu E-ügyintézés felületén, az online kitöltő programban. A program jelzi a hiányzó vagy hibás adatokat.</li>
<li><b>Hitelesítés és beadás.</b> A véglegesítés után generált nyilatkozatot minősített elektronikus aláírással vagy az ingyenes AVDH-szolgáltatással kell hitelesíteni, majd a kérelemhez csatolva beadni. A hiányos vagy hibás nyilatkozat hiánypótlás nélküli elutasítást okozhat.</li>
<li><b>Hiánypótlás, döntés.</b> A hatóság hiánypótlást vagy tisztázó kérdést küldhet rövid határidővel; a döntésről elektronikus értesítés jön.</li>
<li><b>Támogatói okirat, megvalósítás, elszámolás.</b> A projektet a vállalt ütemezés szerint kell megvalósítani, majd elszámolni és a fenntartási időszakban fenntartani.</li></ol>` },
      { h: 'Gyakori hibák', html: `<ul><li>Rossz méretkategória (kapcsolt cégek kihagyása).</li><li>Nem elszámolható költség a költségvetésben.</li><li>Lejárt vagy hiányzó nyilatkozat, aláírás.</li><li>Az utolsó napra hagyott beadás, amikor a keret már kimerülhet.</li></ul>
<p>Sok cég pályázatíró szakemberrel dolgozik; az AIpályázó-n minden felhívásnál kérhet díjmentes konzultációt.</p>` },
    ],
    live: (open) => {
      const soon = open.filter((g) => isDate(g.deadline)).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 1)[0];
      return `Ma ${open.length} nyitott felhívásra lehet pályázni${soon ? `; a legközelebbi határidő ${longDate(soon.deadline)}` : '.'}`;
    },
    faq: [
      { q: 'Hol kell beadni a pályázatot?', a: 'A hazai (Széchenyi Terv Plusz) felhívásokat a palyazat.gov.hu E-ügyintézés felületén, elektronikusan. Az EU-s felhívásokat az EU Funding & Tenders portálon, a KAP-felhívásokat a felhívásban megadott elektronikus felületen.' },
      { q: 'Mennyi idő alatt születik döntés?', a: 'Felhívásonként eltérő; a felhívás és az általános útmutató megadja a határidőket. Az értesítés elektronikusan érkezik.' },
      { q: 'Kell pályázatíró?', a: 'Nem kötelező, de a feltételek és a dokumentáció miatt sok cég szakemberrel dolgozik.' },
    ],
    sources: [
      ['palyazat.gov.hu — Általános útmutató a felhívásokhoz (beadás és értékelés)', 'https://www.palyazat.gov.hu/api/download/65c1ed2c455e7c083bb88308'],
      ['palyazat.gov.hu', 'https://www.palyazat.gov.hu'],
    ],
  },
  {
    slug: 'eu-palyazatok-magyar-cegeknek',
    seoTitle: 'EU-s pályázatok magyar cégeknek: Horizon, EIC',
    updated: '2026-10-13',
    title: 'EU-s pályázatok magyar cégeknek: Horizon Europe, EIC, konzorcium',
    description: 'EU-s pályázatok (Horizon Europe, EIC, LIFE) a Funding & Tenders portálon, többnyire konzorciumban. Kinek érdemes, hogyan induljon.',
    lead: 'Az EU közvetlenül kezelt programjaira (Horizon Europe, EIC, LIFE, Digital Europe, Single Market Programme) az EU Funding & Tenders portálon kell pályázni, angol nyelven. A Horizon Europe kutatási és innovációs témáinak többségére nemzetközi konzorcium kell: jellemzően legalább három, egymástól független szervezet három különböző EU- vagy társult országból. Az EIC Accelerator és a kaszkád (FSTP) felhívások egyedül is pályázhatók.',
    sections: [
      { h: 'Kinek érdemes?', html: `<ul><li><b>Innovatív KKV-knak és startupoknak:</b> EIC Accelerator, EIC Pathfinder, kaszkád felhívások (kisebb összeg, egyszerűbb pályázat).</li>
<li><b>Ipari, technológiai cégeknek</b>, amelyek kutatóhellyel vagy külföldi partnerekkel fejlesztenek: Horizon Europe RIA és IA témák.</li>
<li><b>Környezetvédelmi, energetikai projekteknek:</b> LIFE, Innovation Fund.</li></ul>` },
      { h: 'Hogyan induljon?', html: `<ol><li>Regisztráljon az EU Funding & Tenders portálon; a szervezet PIC-azonosítót kap.</li><li>Válasszon témát (topic) a határidő és a támogatható tevékenységek alapján.</li><li>Konzorciumi témánál keressen partnereket (partnerkereső, nemzeti kapcsolattartók).</li><li>A pályázatot angolul, a portál sablonjaival kell beadni.</li></ol>
<p>A magyar nemzeti kapcsolattartók (NCP) az NKFI Hivatalnál díjmentesen segítenek.</p>` },
    ],
    live: (open, link) => {
      const eu = open.filter((g) => g.scope === 'eu');
      const single = eu.filter((g) => g.singleApplicant === true).length;
      return `Jelenleg ${eu.length} nyitott EU-s felhívást figyelünk; ebből ${single} felhívásra egyetlen szervezet is pályázhat, a többihez jellemzően konzorcium kell. Lásd: ${link('horizon-europe', 'Horizon Europe')}, ${link('eic', 'EIC')}, ${link('eu-egyeb-programok', 'egyéb EU-s programok')}.`;
    },
    faq: [
      { q: 'Pályázhat egyedül egy magyar cég EU-s felhívásra?', a: 'Igen, például az EIC Acceleratorra és a kaszkád (FSTP) felhívásokra. A Horizon Europe témák többségéhez viszont nemzetközi konzorcium kell.' },
      { q: 'Hol kell beadni az EU-s pályázatot?', a: 'Az EU Funding & Tenders portálon, angol nyelven, a szervezet PIC-azonosítójával.' },
      { q: 'Kap segítséget magyar cég az EU-s pályázathoz?', a: 'Igen, az NKFI Hivatal Horizont Európa nemzeti kapcsolattartói díjmentesen tájékoztatnak.' },
    ],
    sources: [
      ['EU Funding & Tenders Portal', 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/home'],
      ['NKFIH — Horizont Európa nemzeti kapcsolattartók', 'https://www.horizonteuropa.nkfih.gov.hu'],
      ['EMDESK: How to build a consortium for Horizon Europe', 'https://www.emdesk.com/horizon-2020-horizon-europe-basics-guide/build-consortium-find-partners-eu-project'],
    ],
  },
];
