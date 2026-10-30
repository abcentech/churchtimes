// Lazy entry for the scripture features. Load with a dynamic import only (never statically from src/main.js):
//   import('./features/growth/scripture/index.js').then(m=>m.mountDailyVerse(el)).catch(()=>{});
//   import('./features/growth/scripture/index.js').then(m=>{dispose=m.mountScriptureRefs(articleBody);}).catch(()=>{});
import './scripture.css';
export {mountDailyVerse,dailyVerseFor} from './daily.js';
export {mountScriptureRefs} from './hover.js';
