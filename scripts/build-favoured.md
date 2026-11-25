# Rebuilding aipalyazo/lib/hu-favoured.js

The favoured-district postcode table comes from three sources:

1. **The decree** — 290/2014. (XI. 26.) Korm. rendelet, https://njt.hu/jogszabaly/2014-290-20-22
   - 3. melléklet: every járás with a 1 in column D, E or F (kedvezményezett /
     fejlesztendő / komplex programmal fejlesztendő) — 109 járás in the
     version in force from 2026-11-07.
   - 4. melléklet: átmenetileg kedvezményezett települések (116 settlements).
2. **Settlement → járás**: Wikidata SPARQL (district of Hungary = Q1162835,
   settlement `wdt:P131` district, postcode `wdt:P281`). The Jánoshalmi járás
   is missing there; its settlements (Jánoshalma, Borota, Kéleshalom,
   Mélykút, Rém) are added by name.
3. **Postcode → settlement**: the `hu-postal-codes` npm package (MIT).

A settlement is favoured when its járás is listed or it is in annex 4; every
postcode of a favoured settlement is favoured. Postcodes shared by favoured
and non-favoured settlements go to PARTIAL (decided by the settlement name).
Both copies (aipalyazo/lib and supabase/functions/_shared) must stay
byte-identical — scripts/match.test.mjs checks it.

Re-check the decree when the government amends it (the njt.hu page shows
"Hatályos: …" at the top).
