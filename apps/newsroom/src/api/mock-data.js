/**
 * Initial Mock Seed Fixtures for Church Times Nigeria Newsroom
 * Reflects genuine Nigerian church reporting context, founder credits,
 * and current editorial manifest.
 */

export const INITIAL_USERS = [
  {
    id: 'user-reporter-1',
    name: 'Gbenga Osinaike',
    role: 'reporter',
    email: 'gbenga@churchtimesnigeria.net',
    desk: 'General Desk & Investigations',
    avatar: 'GO'
  },
  {
    id: 'user-editor-1',
    name: 'Derin Adeogun',
    role: 'section_editor',
    email: 'derin@churchtimesnigeria.net',
    desk: 'Faith & Society Desk',
    avatar: 'DA'
  },
  {
    id: 'user-eic-1',
    name: 'Lanre Ogundipe',
    role: 'editor_in_chief',
    email: 'lanre@churchtimesnigeria.net',
    desk: 'Executive Editorial',
    avatar: 'LO'
  },
  {
    id: 'user-guest',
    name: 'Public Contributor',
    role: 'public',
    email: 'anonymous@reader.net',
    desk: 'Reader Submissions',
    avatar: 'PC'
  }
];

export const INITIAL_CATEGORIES = [
  { id: 'faith-society', slug: 'faith-society', title: 'Faith & Society', description: 'Institutions, public policy, education, health and accountability' },
  { id: 'church-ministry', slug: 'church-ministry', title: 'Church & Ministry', description: 'Verified church reporting, governance and ministry developments' },
  { id: 'people-purpose', slug: 'people-purpose', title: 'People & Purpose', description: 'Profiles and service with independent sourcing' },
  { id: 'business-vocation', slug: 'business-vocation', title: 'Business & Vocation', description: 'Faith, work, enterprise and ethical decisions across the economy' },
  { id: 'culture-ideas', slug: 'culture-ideas', title: 'Culture & Ideas', description: 'Books, arts, informed commentary and critical reviews' }
];

export const INITIAL_MEDIA = [
  {
    id: '29276',
    title: 'Omololu Falobi Archive Portrait',
    url: '/site/news-media/29276.jpg',
    filename: '29276.jpg',
    alt: 'Omololu Falobi (1971–2006), investigative journalist and HIV/AIDS media advocate',
    caption: 'Omololu Falobi legacy review on 20th anniversary',
    credit: 'Falobi Family / Journalists Against AIDS (JAAIDS) Archive',
    license: 'Editorial Archive Use',
    filesize: '169 KB',
    dimensions: '1200x800'
  },
  {
    id: '29267',
    title: 'ANLCA 72nd Stakeholders Meeting',
    url: '/site/news-media/29267.jpg',
    filename: '29267.jpg',
    alt: 'Stakeholders at the ANLCA maritime and clearing agents convention in Lagos',
    caption: 'Maritime stakeholders call for digital transformation at trade summit',
    credit: 'Church Times / Derin Adeogun',
    license: 'Staff Photograph',
    filesize: '73 KB',
    dimensions: '1024x680'
  },
  {
    id: '29264',
    title: 'Teenagers Center Building Dedication',
    url: '/site/news-media/29264.jpg',
    filename: '29264.jpg',
    alt: 'Youth and teenagers community center building in Abuja',
    caption: 'Multimillion naira youth facility dedicated in Abuja',
    credit: 'Church Times Staff / Abuja Bureau',
    license: 'Staff Photograph',
    filesize: '15 KB',
    dimensions: '800x533'
  },
  {
    id: '29259',
    title: 'Omoyele Sowore and Pastor E.A. Adeboye',
    url: '/site/news-media/29259.jpg',
    filename: '29259.jpg',
    alt: 'Omoyele Sowore during meeting with Pastor Enoch Adeboye at Redemption City',
    caption: 'Sowore recounts dialogue on nation-building with Pastor Adeboye',
    credit: 'Courtesy Photo / Handout',
    license: 'Editorial Fair Use',
    filesize: '125 KB',
    dimensions: '1024x576'
  },
  {
    id: '29255',
    title: 'Biblical Faith & Theology Seminar',
    url: '/site/news-media/29255.jpg',
    filename: '29255.jpg',
    alt: 'Christian theological symbol, Bible and open communion table',
    caption: 'Recovering biblical faith in an era of positive confession',
    credit: 'Church Times Archive Illustration',
    license: 'Editorial Stock License',
    filesize: '81 KB',
    dimensions: '992x1024'
  },
  {
    id: '29253',
    title: 'Berean Bible Conference Session',
    url: '/site/news-media/29253.jpg',
    filename: '29253.jpg',
    alt: 'Attendees studying scripture during Berean Bible Conference in Ibadan',
    caption: 'Delegates emphasize practical discipleship at Berean Confab',
    credit: 'Berean Press Bureau',
    license: 'Attributed Press Release',
    filesize: '75 KB',
    dimensions: '1024x683'
  }
];

export const INITIAL_ARTICLES = [
  {
    id: 'art-29276',
    title: 'Omololu Falobi (1971–2006): 20 years of an enduring legacy',
    slug: 'omololu-falobi-1971-2006-20-years-of-an-enduring-legacy',
    category: 'people-purpose',
    standfirst: 'Two decades after the pioneer health journalist passed away, his model of community-centred reporting continues to mentor a new generation.',
    body: `Omololu Falobi was not merely a reporter with an ear for policy; he was an institution builder whose work with Journalists Against AIDS (JAAIDS) changed how Nigerian newsrooms covered public health.\n\nTwenty years after his untimely death on 5 October 2006, colleagues, protégés, and public health advocates gathered in Lagos to reflect on his enduring contributions to development journalism.\n\n"Omololu taught us that journalism is not complete until it defends the most vulnerable," remarked one of his early trainees. His work laid the groundwork for investigative public health reporting across West Africa.`,
    featuredImage: INITIAL_MEDIA[0],
    status: 'published',
    author: INITIAL_USERS[0],
    publishedAt: '2026-10-05T08:20:04Z',
    updatedAt: '2026-10-05T08:20:04Z',
    createdAt: '2026-10-04T14:10:00Z',
    reviewNotes: 'Verified with surviving family and JAAIDS archive. Approved by Editor-in-Chief.',
    revisionCount: 2
  },
  {
    id: 'art-29280',
    title: 'CAN and PFN Joint Council on Rural Church Safety in North-Central',
    slug: 'can-pfn-joint-council-rural-church-safety-north-central',
    category: 'faith-society',
    standfirst: 'Church leaders establish local emergency alert committees across Plateau, Benue, and Southern Kaduna following dialogue with state security chiefs.',
    body: `A consultative council representing the Christian Association of Nigeria (CAN) and the Pentecostal Fellowship of Nigeria (PFN) concluded a three-day summit in Jos today.\n\nThe delegates agreed on a unified grassroots security protocol, urging communities to establish verified early-warning channels rather than relying on unconfirmed social media panic alerts.\n\nRev. Dr. Emmanuel Bature, presiding over the communique committee, emphasized that rural parishes must maintain close coordination with statutory security forces while ensuring humanitarian aid reaches displaced farming families without sectarian discrimination.`,
    featuredImage: INITIAL_MEDIA[1],
    status: 'in_review',
    author: INITIAL_USERS[0],
    publishedAt: null,
    updatedAt: '2026-10-13T11:30:00Z',
    createdAt: '2026-10-13T09:15:00Z',
    reviewNotes: 'Submitted for editorial review. Awaiting fact-check on joint security committee numbers.',
    revisionCount: 1
  },
  {
    id: 'art-29281',
    title: 'The Economic Impact of Clergy Retirement Funds in Southwest Dioceses',
    slug: 'economic-impact-clergy-retirement-funds-southwest-dioceses',
    category: 'business-vocation',
    standfirst: 'An examination of contributory pension compliance among historical missions reveals innovative cooperative investment models.',
    body: `For decades, retired pastors in many independent and mainline churches faced precarious financial conditions upon relinquishing their parish rectories.\n\nHowever, a comprehensive investigation across ten dioceses in Lagos, Ogun, and Oyo reveals a decisive shift toward contributory pension schemes and cooperative agricultural investments.\n\nChurch administrators report that structured gratuity schemes have reduced dependency on ad-hoc congregational farewell offerings by over 60 percent.`,
    featuredImage: INITIAL_MEDIA[4],
    status: 'changes_requested',
    author: INITIAL_USERS[1],
    publishedAt: null,
    updatedAt: '2026-10-13T10:45:00Z',
    createdAt: '2026-10-12T16:20:00Z',
    reviewNotes: 'Editorial note: Please obtain on-the-record confirmation from the Pension Commission or specify the exact cooperative societies surveyed in Ibadan.',
    revisionCount: 3
  },
  {
    id: 'art-29282',
    title: 'Christian Healthcare Workers Launch Free Mobile Clinic in Makoko',
    slug: 'christian-healthcare-workers-free-mobile-clinic-makoko',
    category: 'people-purpose',
    standfirst: 'Volunteer doctors, pharmacists, and midwives from eight denominations treat over 1,400 lagoon residents during weekend medical mission.',
    body: `Over 80 volunteer healthcare workers operated four floating consultation stations across Makoko lagoon settlement on Saturday.\n\nServices included malaria screening, prenatal ultrasound examinations, pediatric deworming, and distribution of clean water purification kits.\n\nDr. Folashade Adeleke, mission coordinator, noted that preventable waterborne infections remain acute, calling on municipal authorities to maintain regular primary healthcare boat visits.`,
    featuredImage: INITIAL_MEDIA[2],
    status: 'approved',
    author: INITIAL_USERS[0],
    publishedAt: null,
    updatedAt: '2026-10-13T12:00:00Z',
    createdAt: '2026-10-13T08:00:00Z',
    reviewNotes: 'Corroborated with Makoko community elders. Photo consent documented. Approved for immediate publishing.',
    revisionCount: 2
  },
  {
    id: 'art-29283',
    title: 'Synod Theologians Re-examine Environmental Stewardship Mandate',
    slug: 'synod-theologians-re-examine-environmental-stewardship',
    category: 'culture-ideas',
    standfirst: 'Draft working paper urges Nigerian pulpits to address plastic pollution, deforestation, and climate impact through biblical creation ethics.',
    body: `A working committee of theological educators has published an urgent draft framework calling for systematic creation care preaching in Nigerian churches.\n\nThe paper challenges the prevailing escapist theology that views ecological degradation as inconsequential to the Christian faith.\n\nWorkshops are scheduled across theological seminaries in Aba, Jos, and Iperu to integrate creation care into pastoral training curricula.`,
    featuredImage: INITIAL_MEDIA[3],
    status: 'draft',
    author: INITIAL_USERS[0],
    publishedAt: null,
    updatedAt: '2026-10-13T13:10:00Z',
    createdAt: '2026-10-13T13:00:00Z',
    reviewNotes: 'Working draft by Gbenga Osinaike. Needs secondary interview from seminary provost in Aba.',
    revisionCount: 1
  }
];

export const INITIAL_SUBMISSIONS = [
  {
    id: 'sub-1048',
    headline: 'Diocese Commissions 15 Solar-Powered Boreholes across Rural Ondo Communities',
    category: 'church-ministry',
    body: 'The Anglican Diocese of Akoko has completed and handed over 15 solar borehole stations to water-scarce farming hamlets along the Akoko-Kogi border. Community leaders and local imams joined bishopric representatives at the commissioning ceremony in Ikakumo.',
    submitterName: 'Venerable Kayode Alabi',
    submitterEmail: 'akokodiocese.media@gmail.com',
    submitterPhone: '+234 803 456 7891',
    organization: 'Akoko Anglican Diocesan Communications',
    location: 'Ikakumo, Ondo State',
    status: 'pending',
    editorNotes: 'Requires corroboration from Ikakumo village head before drafting.',
    createdAt: '2026-10-13T07:15:20Z',
    mediaUrl: null
  },
  {
    id: 'sub-1049',
    headline: 'Youth Entrepreneurship Hub Opened at Ecumenical Center in Jos',
    category: 'business-vocation',
    body: 'A coalition of 12 Christian youth fellowships partnered with private tech mentors to unveil an 80-seat digital co-working and coding lab in Jos. The project offers subsidized fiber internet and solar power to young entrepreneurs developing agricultural software.',
    submitterName: 'Nenrit Danjuma',
    submitterEmail: 'nenrit.danjuma@youthpulse.ng',
    submitterPhone: '+234 812 987 6543',
    organization: 'Plateau Youth Innovation Network',
    location: 'Jos, Plateau State',
    status: 'pending',
    editorNotes: 'Promising lead. Need photo of tech lab and interview with student beneficiaries.',
    createdAt: '2026-10-13T09:40:11Z',
    mediaUrl: null
  },
  {
    id: 'sub-1047',
    headline: 'Dispute Over Church Land Boundary in Ibeju-Lekki Reaches Mediation Council',
    category: 'faith-society',
    body: 'Two growing ministries in the Eleko axis have voluntarily submitted their perimeter survey records to the Lagos State Ministry of Physical Planning after traditional baales convened an amicable boundary resolution session.',
    submitterName: 'Anonymous Legal Observer',
    submitterEmail: 'observer.lekki@proton.me',
    submitterPhone: null,
    organization: 'Lekki Residents Mediation Forum',
    location: 'Eleko, Ibeju-Lekki, Lagos',
    status: 'in_review',
    editorNotes: 'Assigned to Gbenga Osinaike to verify ministry names and court status.',
    createdAt: '2026-10-12T18:22:45Z',
    mediaUrl: null
  }
];

export const INITIAL_LIVE_EVENTS = [
  {
    id: 'event-live-1',
    slug: 'ncef-2026-plenary',
    title: 'National Christian Elders Forum 2026 Emergency Plenary',
    status: 'live',
    description: 'Live reporting from the National Christian Elders Forum emergency consultation on religious freedom, national cohesion, and constitutional reforms holding in Abuja.',
    location: 'NICON Luxury Hotel, Abuja',
    startedAt: '2026-10-13T09:00:00Z',
    activeViewers: 1420
  },
  {
    id: 'event-live-2',
    slug: 'lagos-anglican-synod-2026',
    title: 'Lagos Diocesan Synod 2026: The Church and Urban Renewal',
    status: 'upcoming',
    description: 'Deliberations on education, community healthcare, and clergy welfare at the annual Diocesan Synod opening service.',
    location: 'Cathedral Church of Christ, Marina, Lagos',
    startedAt: '2026-10-15T09:30:00Z',
    activeViewers: 0
  }
];

export const INITIAL_LIVE_UPDATES = [
  {
    id: 'upd-101',
    eventId: 'event-live-1',
    eventSlug: 'ncef-2026-plenary',
    timestamp: '13:45 WAT',
    headline: 'Plenary Adjourns for Closed Drafting Session',
    body: 'The elders forum has temporarily gone into an executive drafting session to finalize the 12-point communique. Press briefing scheduled for 15:30 WAT.',
    reporterName: 'Gbenga Osinaike',
    status: 'approved',
    isPinned: false,
    createdAt: '2026-10-13T12:45:00Z'
  },
  {
    id: 'upd-102',
    eventId: 'event-live-1',
    eventSlug: 'ncef-2026-plenary',
    timestamp: '12:20 WAT',
    headline: 'Elder Solomon Asemota SAN Delivers Keynote on Rule of Law',
    body: 'Elder Solomon Asemota SAN stressed that peace in Nigeria cannot be sustained on discretionary concessions but on strict adherence to constitutional secularity and equal protection under the law for citizens of all creeds.',
    reporterName: 'Gbenga Osinaike',
    status: 'approved',
    isPinned: true,
    createdAt: '2026-10-13T11:20:00Z'
  },
  {
    id: 'upd-103',
    eventId: 'event-live-1',
    eventSlug: 'ncef-2026-plenary',
    timestamp: '10:50 WAT',
    headline: 'Representatives of North-East Internally Displaced Farmers Present Memorandum',
    body: 'A delegation representing farming communities in southern Borno and Adamawa presented documentation of ongoing land disputes, urging religious leaders to push for resettlement support before the planting season ends.',
    reporterName: 'Gbenga Osinaike',
    status: 'approved',
    isPinned: false,
    createdAt: '2026-10-13T09:50:00Z'
  },
  {
    id: 'upd-104',
    eventId: 'event-live-1',
    eventSlug: 'ncef-2026-plenary',
    timestamp: '14:10 WAT',
    headline: 'Draft Communique Reaches Final Committee Review',
    body: 'Drafting committee members including retired military commanders and legal scholars are currently vetting paragraph 4 on community policing and judicial accountability.',
    reporterName: 'Gbenga Osinaike',
    status: 'pending_review',
    isPinned: false,
    createdAt: '2026-10-13T13:10:00Z'
  }
];
