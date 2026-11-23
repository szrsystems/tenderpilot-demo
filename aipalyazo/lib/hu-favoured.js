/* =========================================================================
 * AIpályázó — favoured districts ("kedvezményezett járások")
 * Source: 290/2014. (XI. 26.) Korm. rendelet 3. melléklet (kedvezményezett,
 * fejlesztendő and komplex programmal fejlesztendő járások, 109) and
 * 4. melléklet (átmenetileg kedvezményezett települések, 116), as in force
 * from 2026-11-07 (njt.hu). Settlement → járás from Wikidata, postcode →
 * settlement from the hu-postal-codes package (MIT).
 * Rebuild when the decree changes: scripts/build-favoured.md.
 *   AIPFav.status('3600', 'Ózd') → 'yes' | 'no' | 'unknown'
 * ========================================================================= */
(function (root) {
  'use strict';
  // Postcodes where every settlement is favoured (sorted, base-36 deltas;
  // "_xyz" = a 3-digit delta).
  var ENC = '_1of11_01m62171111_04y11_04v15111221112121111211111111111121111111118121121117111311121111b11h51112511355411111_02h12189211111111_01k11_02m111111411731111111311214i225c211111121111111311111141111611255111121111111_01g212111221111111o1a11qa11111421111111311111118121111211211111112ab1112113111115a1116812111111_02qo5644d1121135151111111311111111211171s4c1121111221211116111711111111211112111913317114921111114415111214111211121111531115111111412111131111111112111111115111312111112111111411115411111211112411121125211211111111_01p41112231551135113a4111112111111321111113111114b1117111111421gb1847111161111611181121411116211111cb9411141111111311811111511811111_01s1513517111113121811111311111511841141111911141111116111113111111xba11112131111611111_01il191111241121512115111111x317118111251111151111_01jb111719111111411111113111115111111112111111_0251r1hba11111451141118_01cb11991111621_01k91b111799181211_011b18aa9211811116311o285145113421111b11215_01o126b27c11111141_01b511412a11141_01cb9a611_01q311e15618512_02bt22111355511126112b1116b11111_01sba111651111_01pb932111311111141111111311_01bb11171111555411111211111_0183819111121_020c9111155145111_034412114117111115111551f_02738111111411811_01v3811111111mk11111141911111132111211_02h311115b111191111n1121113a11111321111f41q1117111111112641j211152124v121132111711111113211611111111lb1111114111111321211112111161121141116c211111_020218911b114b121111231111131122861111112723111161111fc1225112191112231421_01ac11133131621113b21312421131121122421_03fa1111113111111111h_04ub121111121311_026k111281221111112111161111113b11111113118118118111111131111619a1111111w53261119261112111115211611111111151111111112111211111231111111141111221117312f213112121111n212d92111441111241121116111322ka4511c1521126322211182_034l1211141121_0a4b11111141181117121211221115_03f1_02j1nb118211151111151_024d1111111311111';
  // Postcodes shared by favoured and non-favoured settlements.
  var PARTIAL = {"2943": ["Tárkány"], "7370": ["Oroszló"], "8756": ["Kisrécse", "Zalasárszeg"], "8762": ["Szentpéterúr"], "8774": ["Gelse", "Kilimán"]};
  var FULL = {};
  (function () {
    var prev = 0, i = 0, d;
    while (i < ENC.length) {
      if (ENC[i] === '_') { d = parseInt(ENC.substr(i + 1, 3), 36); i += 4; } else { d = parseInt(ENC[i], 36); i += 1; }
      prev += d; FULL[prev] = 1;
    }
  })();
  function norm(s) { return String(s || '').trim().toLowerCase(); }
  // pc: 4-digit postcode (string or number); city: optional settlement name.
  function status(pc, city) {
    var m = String(pc == null ? '' : pc).match(/\b(\d{4})\b/);
    if (!m) return 'unknown';
    var n = +m[1];
    if (n < 1000) return 'unknown';
    if (n < 2000) return 'no'; // Budapest
    if (FULL[n]) return 'yes';
    var part = PARTIAL[String(n)];
    if (part) {
      if (!city) return 'unknown';
      var c = norm(city);
      return part.some(function (x) { return norm(x) === c; }) ? 'yes' : 'no';
    }
    return 'no';
  }
  // "8749 Zalakaros", "Zalakaros, 8749" → status
  function statusOfLocation(loc) {
    var s = String(loc || '');
    var m = s.match(/\b(\d{4})\b/);
    if (!m) return 'unknown';
    var city = s.replace(m[0], '').replace(/[,.]/g, ' ').trim().split(/\s{2,}|,/)[0];
    return status(m[1], city);
  }
  var api = { status: status, statusOfLocation: statusOfLocation, size: function () { return Object.keys(FULL).length; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIPFav = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
