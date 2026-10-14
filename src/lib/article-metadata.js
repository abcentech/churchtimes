const defaultDescription = 'Professional reporting on the church, the people and the world we share.';
function meta(property, content) {
  let element = document.head.querySelector(`meta[property="${property}"]`);
  if (!element) { element = document.createElement('meta'); element.setAttribute('property', property); document.head.append(element); }
  element.content = content;
  element.dataset.publicArticleMetadata = '';
}
export function clearArticleMetadata() {
  document.head.querySelectorAll('[data-public-article-metadata]').forEach(element => element.remove());
  meta('og:title', 'Church Times Nigeria');
  meta('og:description', defaultDescription);
  meta('og:type', 'website');
}
export function setArticleMetadata(article, canonical) {
  clearArticleMetadata();
  const url = new URL(canonical);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid article canonical URL');
  const link = document.createElement('link'); link.rel = 'canonical'; link.href = url.href;
  link.dataset.publicArticleMetadata = ''; document.head.append(link);
  meta('og:type', 'article'); meta('og:title', article.title); meta('og:description', article.excerpt);
  meta('og:url', url.href);
  if (article.featuredImage) meta('og:image', article.featuredImage.heroUrl);
  if (article.publishedAt) meta('article:published_time', article.publishedAt);
  if (article.updatedAt) meta('article:modified_time', article.updatedAt);
  const data = {
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline: article.title,
    description: article.excerpt, mainEntityOfPage: url.href,
    publisher: { '@type': 'Organization', name: 'Church Times Nigeria' },
    ...(article.publishedAt ? { datePublished: article.publishedAt } : {}),
    ...(article.updatedAt ? { dateModified: article.updatedAt } : {}),
    ...(article.bylineName ? { author: { '@type': 'Person', name: article.bylineName } } : {}),
    ...(article.featuredImage ? { image: [article.featuredImage.heroUrl] } : {}),
  };
  const script = document.createElement('script'); script.type = 'application/ld+json';
  script.dataset.publicArticleMetadata = '';
  script.textContent = JSON.stringify(data).replace(/</g, '\\u003c'); document.head.append(script);
}
