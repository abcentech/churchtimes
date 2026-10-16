import {renderArticleTable} from './article-table.js';
import { normalizePublicMedia, cmsFigure } from './cms-media.js';
// Render supported Payload Lexical text and populated public media safely.
// Unknown nodes, unpopulated relationships and embedded HTML are omitted.
const escape = text => String(text).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function safeLink(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function renderArticleContent(content, {baseUrl} = {}) {
  if (typeof content === 'string') {
    return content.trim().split(/\n\s*\n/).filter(Boolean).map(text => `<p>${escape(text)}</p>`).join('');
  }
  let tableNumber=0,lastHeadingLevel=1,tableRemaining=20000;
  const articleBudget={remaining:5000};
  function render(node, depth = 0, budget=articleBudget,tableState=null) {
    if (!node || typeof node !== 'object') return '';
    if (depth > 30 || --budget.remaining < 0) {if(tableState)tableState.shortened=true;return '';}
    if(tableState && --tableRemaining<0){tableState.shortened=true;return '';}
    if(node.type==='block' && node.fields?.blockType==='youtubeEmbed') {
      const {videoId,title}=node.fields;
      if(typeof videoId!=='string'||!/^[-_A-Za-z0-9]{11}$/.test(videoId))return '';
      const label=typeof title==='string'&&title.trim()?`Watch video on YouTube: ${title.trim()}`:'Watch video on YouTube';
      return `<p><a href="https://www.youtube.com/watch?v=${videoId}" rel="noopener noreferrer">${escape(label)}</a></p>`;
    }
    if (node.type === 'text' && typeof node.text === 'string') {
      let text = escape(node.text);
      if (node.format & 1) text = `<strong>${text}</strong>`;
      if (node.format & 2) text = `<em>${text}</em>`;
      if (node.format & 4) text = `<s>${text}</s>`;
      if (node.format & 8) text = `<u>${text}</u>`;
      if (node.format & 16) text = `<code>${text}</code>`;
      if (node.format & 32) text = `<sub>${text}</sub>`;
      if (node.format & 64) text = `<sup>${text}</sup>`;
      return text;
    }
    if (node.type === 'upload' && node.relationTo === 'media') return cmsFigure(normalizePublicMedia(node.value,baseUrl));
    if (node.type === 'table') {
      const state=tableState||{shortened:false},tableBudget=tableState?budget:{remaining:10000};
      return renderArticleTable(node,children=>{
        const html=[];
        for(const child of Array.isArray(children)?children:[]) {
          if(tableBudget.remaining<=0||tableRemaining<=0){state.shortened=true;break;}
          html.push(render(child,depth+3,tableBudget,state));
        }
        return html.join('');
      },{number:++tableNumber,state,consume:()=>--tableBudget.remaining>=0&&--tableRemaining>=0});
    }
    if (node.type === 'linebreak') return '<br>';
    const supported = ['root', 'paragraph', 'heading', 'quote', 'list', 'listitem', 'link', 'autolink'];
    if (!supported.includes(node.type)) return '';
    const rendered=[];
    for(const child of Array.isArray(node.children)?node.children:[]) {
      if(budget.remaining<=0 || (tableState&&tableRemaining<=0)){if(tableState)tableState.shortened=true;break;}
      rendered.push(render(child,depth+1,budget,tableState));
    }
    const children=rendered.join('');
    if (!children) return '';
    switch (node.type) {
      case 'paragraph': return `<p>${children}</p>`;
      case 'heading': {
        if(!children.replace(/<[^>]*>/g,'').trim())return '';
        const requested=/^h[1-6]$/.test(node.tag)?Math.max(2,Number(node.tag[1])):2;
        lastHeadingLevel=Math.min(requested,lastHeadingLevel+1);
        const tag='h'+lastHeadingLevel;
        return `<${tag}>${children}</${tag}>`;
      }
      case 'quote': return `<blockquote>${children}</blockquote>`;
      case 'list': {
        const tag = node.listType === 'number' ? 'ol' : 'ul';
        return `<${tag}>${children}</${tag}>`;
      }
      case 'listitem': return `<li>${children}</li>`;
      case 'link':
      case 'autolink': {
        const url = safeLink(node.fields?.url ?? node.url);
        return url ? `<a href="${escape(url)}" rel="noopener noreferrer">${children}</a>` : children;
      }
      default: return children;
    }
  }
  return render(content?.root);
}
