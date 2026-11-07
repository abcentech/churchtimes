const span=(name,value)=>Number.isSafeInteger(value)&&value>1?` ${name}="${Math.min(value,20)}"`:'';
// Standard serialized Lexical table nodes only; no raw HTML, styles or attributes.
export function renderArticleTable(node,renderChildren,{number=1,consume=()=>true,state={shortened:false}}={}) {
  number=Number.isSafeInteger(number)&&number>0?number:1;
  const sourceRows=(Array.isArray(node.children)?node.children:[]).filter(row=>row?.type==='tablerow');
  if(sourceRows.length>100)state.shortened=true;
  const rows=[];
  for(const row of sourceRows.slice(0,100)) {
    if(!consume()){state.shortened=true;break;}
    const sourceCells=(Array.isArray(row.children)?row.children:[]).filter(cell=>cell?.type==='tablecell');
    if(sourceCells.length>20)state.shortened=true;
    const cells=[];
    for(const cell of sourceCells.slice(0,20)) {
      if(!consume()){state.shortened=true;break;}
      const header=Number.isSafeInteger(cell.headerState)?cell.headerState&3:0;
      const tag=header?'th':'td',scope=header===1?' scope="col"':header===2?' scope="row"':'';
      cells.push(`<${tag}${scope}${span('colspan',cell.colSpan)}${span('rowspan',cell.rowSpan)}>${renderChildren(cell.children)}</${tag}>`);
    }
    if(cells.length)rows.push('<tr>'+cells.join('')+'</tr>');
  }
  const note=state.shortened?'<p class="article-table-note">Table shortened to keep this article readable.</p>':'';
  return rows.length?`<div class="article-table" tabindex="0" role="region" aria-label="Article data table ${number}"><table><tbody>${rows.join('')}</tbody></table>${note}</div>`:note;
}
