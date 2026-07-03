/* exam.js — shared pass/fail rating persistence for exam/ section pages.
   Extracted from the per-section inline <script> blocks, which were identical
   except for `const SEC=N,MAX=M` (MAX was unused). The section number now comes
   from <body data-section="N">. Scores are saved per section in localStorage. */
(function(){
const SEC=document.body.dataset.section;
function save(d,v){localStorage.setItem('exam-s'+SEC+'-d'+d,v)}
function restore(){document.querySelectorAll('.drill-row .rbtn').forEach(b=>{let test=b.closest('.drill-row').querySelector('.test-result').dataset.test.split('-')[1];let v=localStorage.getItem('exam-s'+SEC+'-d'+test);if(v){let card=b.closest('.drill-row'),btns=card.querySelectorAll('.rbtn');btns.forEach(x=>{x.className='rbtn rbtn-'+x.dataset.value});b.classList.add(v==='pass'?'active-pass':v==='fail'?'active-fail':'active-na')}})}
document.querySelectorAll('.drill-row .rbtn').forEach(b=>{b.addEventListener('click',function(){
  let val=this.dataset.value,row=this.closest('.drill-row'),btns=row.querySelectorAll('.rbtn'),test=row.querySelector('.test-result').dataset.test.split('-')[1];
  btns.forEach(x=>{x.className='rbtn rbtn-'+x.dataset.value});
  if(val==='pass'){this.classList.add('active-pass');save(test,'pass')}
  else if(val==='fail'){this.classList.add('active-fail');save(test,'fail')}
  else{this.classList.add('active-na');save(test,'na')}
})});
restore();
})();
