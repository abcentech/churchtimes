import { test } from 'node:test';
import assert from 'node:assert/strict';
import edition from '../src/data/stories.json' with { type: 'json' };
import { selectHomepage, uniqueHomeReports } from '../src/lib/homepage.js';
import { selectDirectCampaign } from '../src/lib/advertising.js';
const now = Date.parse('2026-10-13T12:00:00Z');
const campaign = {id:'direct-1',status:'active',sponsor:'Demo sponsor',alt:'Demo campaign',priority:1,
  startsAt:'2026-10-01T00:00:00Z',endsAt:'2026-11-01T00:00:00Z',destinationUrl:'https://example.org/campaign',
  placements:['homepage-billboard'],creatives:{'homepage-billboard':{
    desktop:{src:'campaigns/billboard.webp',width:970,height:250},mobile:{src:'https://example.org/mobile.webp',width:320,height:100},
  }}};

test('homepage sections stay unique for every filter and load-more state', () => {
  for (const filter of ['All','News','Business','Features','Opinion','Interviews']) {
    for (const limit of [6,12,30]) {
      const view=selectHomepage([...edition.stories,edition.stories[0]],{filter,limit});
      const shown=[view.lead,...view.featured,...view.shown,...view.perspectives];
      assert.equal(new Set(shown.map(s=>s.slug)).size,shown.length);
      assert.equal(view.lead.id,29259);
      if(filter==='Business')assert.equal(view.shown.length,2);
      if(filter==='Interviews')assert.equal(view.shown.length,2);
    }
  }
});
test('CMS homepage reports deduplicate against displayed edition stories and each other', () => {
  const view=selectHomepage(edition.stories);
  const articles=[{slug:view.lead.slug},{slug:view.shown[0].slug},{slug:'fresh-news'},{slug:'fresh-news'}];
  assert.deepEqual(uniqueHomeReports(articles,view),[{slug:'fresh-news'}]);
});
test('paid delivery config selects eligible direct campaigns by priority before fallback', () => {
  assert.equal(selectDirectCampaign('homepage-billboard',[campaign],now),campaign);
  const premium={...campaign,id:'premium',priority:10};
  assert.equal(selectDirectCampaign('homepage-billboard',[campaign,premium],now),premium);
});
test('unsold, inactive, expired, premature and unsupported placements collapse', () => {
  for(const change of [{status:'draft'},{status:'paused'},{endsAt:'2026-10-13T12:00:00Z'},
    {startsAt:'2027-01-01T00:00:00Z'},{startsAt:'invalid'},{placements:{}},{placements:[]}]) {
    assert.equal(selectDirectCampaign('homepage-billboard',[{...campaign,...change}],now),null);
  }
  assert.equal(selectDirectCampaign('unknown',[campaign],now),null);
  assert.equal(selectDirectCampaign('homepage-billboard',null,now),null);
});
test('malformed creatives and unsafe advertising URLs never qualify', () => {
  for(const destinationUrl of ['javascript:alert(1)','data:text/html,evil','http://example.org','https://user:password@example.org']) {
    assert.equal(selectDirectCampaign('homepage-billboard',[{...campaign,destinationUrl}],now),null);
  }
  for(const src of ['../outside.webp','//example.org/image','javascript:alert(1)','data:image/svg+xml,evil']) {
    const creatives={'homepage-billboard':{...campaign.creatives['homepage-billboard'],mobile:{src,width:320,height:100}}};
    assert.equal(selectDirectCampaign('homepage-billboard',[{...campaign,creatives}],now),null);
  }
  const creatives={'homepage-billboard':{desktop:campaign.creatives['homepage-billboard'].desktop}};
  assert.equal(selectDirectCampaign('homepage-billboard',[{...campaign,creatives}],now),null);
});
