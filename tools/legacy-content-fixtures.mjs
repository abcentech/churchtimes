// SYNTHETIC corpus of standard Lexical nodes. Not a WordPress export/import stub.
// No real people, contact data, HTML embeds or legacy URL mappings are included.
export const LEGACY_SAMPLE_COUNT=50;
const text=(value,format=0)=>({type:'text',version:1,text:value,format,detail:0,mode:'normal',style:''});
const block=(type,children,extra={})=>({type,version:1,format:'',indent:0,direction:'ltr',children,...extra});
export function syntheticLegacyContent(index,mediaValue) {
  if(!Number.isSafeInteger(index)||index<1||index>LEGACY_SAMPLE_COUNT)throw new Error('Synthetic legacy index out of range');
  const n=String(index).padStart(2,'0');
  const cell=(value,headerState=0)=>block('tablecell',[block('paragraph',[text(value)])],{headerState,colSpan:1,rowSpan:1});
  return {root:block('root',[
    block('heading',[text('Synthetic legacy heading '+n)],{tag:index%2?'h2':'h3'}),
    block('paragraph',[text('Synthetic archived narrative '+n+'. '),text('Formatted emphasis.',index%2?1:2)]),
    block('quote',[block('paragraph',[text('Synthetic quotation '+n)])]),
    block('list',[block('listitem',[text('First synthetic point '+n)],{value:1}),block('listitem',[text('Second synthetic point '+n)],{value:2})],{listType:index%2?'bullet':'number',start:1,tag:index%2?'ul':'ol'}),
    block('paragraph',[block('link',[text('Synthetic reference '+n)],{fields:{url:'https://example.test/reference-'+n,newTab:false,linkType:'custom'}})]),
    {type:'upload',version:3,relationTo:'media',value:mediaValue,fields:{}},
    block('table',[
      block('tablerow',[cell('Synthetic year',1),cell('Synthetic count',1)]),
      block('tablerow',[cell(String(2000+index%25),2),cell(String(index*3))]),
    ]),
    // Deliberately unsupported nodes demonstrate fail-closed behavior.
    {type:'html',version:1,html:'<script>window.legacyLeak=true</script>'},
    block('paragraph',[block('link',[text('Unsafe scheme omitted '+n)],{fields:{url:'javascript:window.legacyLeak=true'}})]),
  ])};
}
