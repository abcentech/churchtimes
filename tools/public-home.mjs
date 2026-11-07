import edition from '../src/data/stories.json' with {type:'json'};
import imageSizes from '../src/data/image-sizes.json' with {type:'json'};
import {selectHomepage} from '../src/lib/homepage.js';
import {escapeAttribute as escape,siteCanonical} from '../src/lib/public-metadata.js';
export function homeImageMetadata({siteUrl,basePath,cmsConfigured=false}) {
  // A CMS homepage may have a different lead on every request. Use the site
  // mark for social previews instead of advertising a bundled fallback story.
  if(cmsConfigured) {
    const canonical=siteCanonical(basePath+'site/pwa/icon-512.png',{siteUrl});
    return canonical?`<meta property="og:image" content="${escape(canonical)}"><meta property="og:image:alt" content="Church Times Nigeria"><meta property="og:image:width" content="512"><meta property="og:image:height" content="512">`:'';
  }
  const {lead}=selectHomepage(edition.stories),image=imageSizes[lead.id];
  if(!lead.image || !image)return '';
  const path=basePath+'site/'+lead.image;
  const srcset=image.variants.map(width=>`${basePath}site/news-media/responsive/${lead.id}-${width}.webp ${width}w`).join(', ');
  const canonical=siteCanonical(path,{siteUrl});
  return `<link data-public-metadata rel="preload" as="image" href="${escape(path)}" imagesrcset="${escape(srcset)}" imagesizes="(max-width: 760px) calc(100vw - 38px), 65vw" fetchpriority="high">`+(canonical?`<meta property="og:image" content="${escape(canonical)}"><meta property="og:image:alt" content="${escape(lead.imageAlt || lead.title)}"><meta property="og:image:width" content="${image.width}"><meta property="og:image:height" content="${image.height}">`:'');
}
