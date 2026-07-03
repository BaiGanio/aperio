/* scorecard.js — shared pass/fail scorecard for evaluate/ test suites.

   Extracted from the per-page inline <script> blocks, which were identical apart
   from three knobs. Each page sets `window.SCORECARD` inline before loading this:

     tests  – number of scored (non-bonus) tests
     bonus  – true if test (tests+1) exists as an unscored bonus row
     tiers  – result tiers in priority order (first match wins). Each entry is
              { tier } plus exactly one threshold:
                all:true  → matches when passes === answered (a)
                frac:x    → matches when passes >= a * x
                min:n     → matches when passes >= n   (absolute)

   `tier` must equal a data-tier on a #resultsTier .rt-card. Bespoke suites
   (design-diversity, skill-matching) keep their own inline logic and do not use
   this file. Depends on the scorecard markup + styles-evaluate.css. */
(function(){
const CFG=window.SCORECARD||{},T=CFG.tests,BONUS=!!CFG.bonus,TIERS=CFG.tiers||[],MAXT=BONUS?T+1:T;
const H={pass:'<span class="sc-badge sc-pass">✓ Pass</span>',fail:'<span class="sc-badge sc-fail">✗ Fail</span>',na:'<span class="sc-badge sc-na">— N/A</span>',empty:'<span class="sc-badge sc-empty">—</span>'};
let R={};
function pickTier(p,a){for(const t of TIERS){if(t.all){if(p===a)return t.tier}else if('frac'in t){if(p>=a*t.frac)return t.tier}else if(p>=t.min)return t.tier}return null}
function U(){let p=0,f=0,n=0,bp=0,bf=0,bn=0;for(let t=1;t<=MAXT;t++){let c=document.getElementById('sr-'+t),v=R[t],r=document.querySelector('#scorecardTable tr[data-test="'+t+'"]');if(!c)continue;c.innerHTML=v?H[v]:H.empty;if(r){r.classList.remove('row-pass','row-fail');if(v==='pass')r.classList.add('row-pass');if(v==='fail')r.classList.add('row-fail')}if(t<=T){if(v==='pass')p++;if(v==='fail')f++;if(v==='na')n++}else{if(v==='pass')bp++;if(v==='fail')bf++;if(v==='na')bn++}}
let a=T-n,tr=document.getElementById('sc-total'),fb=document.getElementById('scoreFeedback');if(a===0){tr.textContent=BONUS?'TOTAL: ____ / '+T+' passed  (or ____ / '+(T+1)+' with bonus)':'TOTAL: ____ / '+T+' passed';fb.className='score-feedback';fb.textContent=''}else{if(BONUS){let bt=a+(bn?0:1),bpt=p+bp;tr.textContent='TOTAL: '+p+' / '+a+' passed  (or '+bpt+' / '+bt+' with bonus)'}else{tr.textContent='TOTAL: '+p+' / '+a+' passed'}
if((p+f)===a){P(pickTier(p,a));fb.className='score-feedback visible';fb.textContent=p+' of '+a+' passed — see the highlighted card below'}else{S();fb.className='score-feedback';fb.textContent=''}}
document.querySelectorAll('.test-card').forEach(c=>{let tr=c.querySelector('.test-result');if(tr){let tn=parseInt(tr.dataset.test);if(R[tn])c.classList.add('answered');else c.classList.remove('answered')}})}
function P(t){document.querySelectorAll('#resultsTier .rt-card').forEach(c=>{c.classList.remove('pulse');if(c.dataset.tier===t){c.classList.add('pulse');c.scrollIntoView({behavior:'smooth',block:'nearest'})}})}
function S(){document.querySelectorAll('#resultsTier .rt-card').forEach(c=>c.classList.remove('pulse'))}
document.querySelectorAll('.test-result').forEach(g=>{let tn=parseInt(g.dataset.test),bs=g.querySelectorAll('.rbtn');bs.forEach(b=>{b.addEventListener('click',()=>{let v=b.dataset.value;if(R[tn]===v)R[tn]=null;else R[tn]=v;bs.forEach(b2=>{b2.classList.remove('active-pass','active-fail','active-na');if(R[tn]===b2.dataset.value)b2.classList.add('active-'+b2.dataset.value)});U()})})})})();
