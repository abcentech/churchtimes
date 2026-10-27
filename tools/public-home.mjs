import edition from '../src/data/stories.json' with {type:'json'};
import imageSizes from '../src/data/image-sizes.json' with {type:'json'};
import {selectHomepage} from '../src/lib/homepage.js';
import {escapeAttribute as escape,siteCanonical} from '../src/lib/public-metadata.js';
export function homeImageMetadata({siteUrl,basePath}) {
  const {lead}=selectHomepage(edition.stories),image=imageSizes[lead.id];
  if(!lead.image || !image)return '';
  const path=basePath+'site/'+lead.image;
  const srcset=image.variants.map(width=>`${basePath}site/news-media/responsive/${lead.id}-${width}.webp ${width}w`).join(', ');
  const canonical=siteCanonical(path,{siteUrl});
  return `<link data-public-metadata rel="preload" as="image" href="${escape(path)}" imagesrcset="${escape(srcset)}" imagesizes="(max-width: 760px) calc(100vw - 38px), 65vw" fetchpriority="high">`+(canonical?`<meta property="og:image" content="${escape(canonical)}"><meta property="og:image:alt" content="${escape(lead.imageAlt || lead.title)}"><meta property="og:image:width" content="${image.width}"><meta property="og:image:height" content="${image.height}">`:'');
}
