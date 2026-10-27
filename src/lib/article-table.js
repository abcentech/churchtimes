const span=(name,value)=>Number.isSafeInteger(value)&&value>1&&value<=20?` ${name}="${value}"`:'';
// Standard serialized Lexical table nodes only; no raw HTML, styles or attributes.
export function renderArticleTable(node,renderChildren,{number=1,consume=()=>true}={}) {
  number=Number.isSafeInteger(number)&&number>0?number:1;
  const rows=(Array.isArray(node.children)?node.children:[]).filter(row=>row?.type==='tablerow').slice(0,100);
  const html=rows.map(row=>{
    if(!consume())return "";
    const cells=(Array.isArray(row.children)?row.children:[]).filter(cell=>cell?.type==='tablecell').slice(0,20);
    return cells.length?'<tr>'+cells.map(cell=>{
      if(!consume())return "";
      const state=Number.isSafeInteger(cell.headerState)?cell.headerState&3:0;
      const tag=state?'th':'td',scope=state===1?' scope="col"':state===2?' scope="row"':'';
      return `<${tag}${scope}${span('colspan',cell.colSpan)}${span('rowspan',cell.rowSpan)}>${renderChildren(cell.children)}</${tag}>`;
    }).join('')+'</tr>':'';
  }).join('');
  return html?`<div class="article-table" tabindex="0" role="region" aria-label="Article data table ${number}"><table><tbody>${html}</tbody></table></div>`:'';
}
