/* AIpályázó portal — small shared helpers (industry labels, amount parsing). */
var INDUSTRY_OPTS = [['IT','Informatika, szoftver'],['Manufacturing','Gyártás, ipar'],['Construction','Építőipar'],['HVAC','Épületgépészet, energetika'],['Retail','Kereskedelem'],['Tourism','Szálláshely, turizmus'],['Restaurant','Vendéglátás'],['Agriculture','Mezőgazdaság, élelmiszer'],['Healthcare','Egészségügy'],['Education','Oktatás, képzés'],['General','Egyéb szolgáltatás']];
function industryLabel(code) { var o = INDUSTRY_OPTS.filter(function (x) { return x[0] === code; })[0]; return o ? o[1] : code; }
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
