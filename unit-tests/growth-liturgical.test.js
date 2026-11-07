import test from 'node:test';
import assert from 'node:assert/strict';
import {westernEaster,orthodoxEaster,adventSunday,baptismOfTheLord,liturgicalYear,seasonFor,lagosDate,colourName,MIN_YEAR,MAX_YEAR} from '../src/features/growth/liturgical.js';

const weekday=iso=>new Date(`${iso}T00:00:00Z`).getUTCDay();

test('Western Easter matches published dates, including the earliest and latest possible',()=>{
  const known={1818:'1818-03-22',1943:'1943-04-25',2000:'2000-04-23',2008:'2008-03-23',2010:'2010-04-04',2011:'2011-04-24',2019:'2019-04-21',2020:'2020-04-12',2021:'2021-04-04',2022:'2022-04-17',2023:'2023-04-09',2024:'2024-03-31',2025:'2025-04-20',2026:'2026-04-05',2027:'2027-03-28',2028:'2028-04-16',2029:'2029-04-01',2030:'2030-04-21',2038:'2038-04-25',2285:'2285-03-22'};
  for(const [year,date] of Object.entries(known))assert.equal(westernEaster(Number(year)),date,year);
});

test('Orthodox Easter matches published dates (Gregorian calendar)',()=>{
  const known={2008:'2008-04-27',2020:'2020-04-19',2021:'2021-05-02',2022:'2022-04-24',2023:'2023-04-16',2024:'2024-05-05',2025:'2025-04-20',2026:'2026-04-12',2027:'2027-05-02',2028:'2028-04-16'};
  for(const [year,date] of Object.entries(known))assert.equal(orthodoxEaster(Number(year)),date,year);
});

test('every year 1900-2199: Easters are Sundays in range; Advent Sunday and the Baptism are the right Sundays',()=>{
  for(let year=1900;year<=2199;year++) {
    const easter=westernEaster(year),orthodox=orthodoxEaster(year);
    assert.equal(weekday(easter),0,`Easter ${year}`);
    assert.ok(easter>=`${year}-03-22` && easter<=`${year}-04-25`,`Easter range ${year}`);
    assert.equal(weekday(orthodox),0,`Orthodox ${year}`);
    assert.ok(orthodox>=easter,`Orthodox Easter is never before Western Easter ${year}`);
    assert.ok(orthodox>=`${year}-04-03` && orthodox<=`${year}-05-10`,`Orthodox range ${year}`);
    const advent=adventSunday(year);
    assert.equal(weekday(advent),0);
    assert.ok(advent>=`${year}-11-27` && advent<=`${year}-12-03`,`Advent ${year}`);
    const baptism=baptismOfTheLord(year);
    assert.equal(weekday(baptism),0);
    assert.ok(baptism>=`${year}-01-07` && baptism<=`${year}-01-13`,`Baptism ${year}`);
  }
});

test('movable feasts are derived from Easter (2026)',()=>{
  const feasts=Object.fromEntries(liturgicalYear(2026).map(f=>[f.key,f.date]));
  assert.deepEqual(feasts,{
    epiphany:'2026-01-06',baptism:'2026-01-11','ash-wednesday':'2026-02-18','palm-sunday':'2026-03-29','maundy-thursday':'2026-04-02',
    'good-friday':'2026-04-03','holy-saturday':'2026-04-04',easter:'2026-04-05','orthodox-easter':'2026-04-12',ascension:'2026-05-14',
    pentecost:'2026-05-24',trinity:'2026-05-31','advent-sunday':'2026-11-29',christmas:'2026-12-25',
  });
  const dates=liturgicalYear(2026).map(f=>f.date);
  assert.deepEqual(dates,[...dates].sort(),'feasts are in date order');
  assert.equal(weekday(feasts['ash-wednesday']),3);
  assert.equal(weekday(feasts.ascension),4);
});

test('season boundaries across 2026',()=>{
  const cases={
    '2026-01-01':['christmas','white'],'2026-01-05':['christmas','white'],'2026-01-06':['epiphany','white'],'2026-01-11':['epiphany','white'],
    '2026-01-12':['ordinary','green'],'2026-02-17':['ordinary','green'],'2026-02-18':['lent','purple'],'2026-03-28':['lent','purple'],
    '2026-03-29':['holy-week','red'],'2026-04-02':['holy-week','white'],'2026-04-04':['holy-week','purple'],'2026-04-05':['easter','white'],
    '2026-05-24':['easter','red'],'2026-05-25':['ordinary','green'],'2026-10-30':['ordinary','green'],'2026-11-28':['ordinary','green'],
    '2026-11-29':['advent','purple'],'2026-12-24':['advent','purple'],'2026-12-25':['christmas','white'],'2026-12-31':['christmas','white'],
  };
  for(const [date,[key,colour]] of Object.entries(cases)) {
    const season=seasonFor(date);
    assert.equal(season.key,key,date);assert.equal(season.colour,colour,date);assert.equal(season.date,date);
  }
  assert.equal(seasonFor('2026-04-05').feast.name,'Easter Day');
  assert.equal(seasonFor('2026-04-12').feast,null,'Orthodox Easter is listed but does not set the Western season feast');
  assert.equal(seasonFor('2026-10-30').feast,null);
  assert.equal(colourName('purple'),'Purple');
});

test('Lagos civil date is UTC+1 all year, with no daylight saving',()=>{
  assert.equal(lagosDate(new Date('2026-10-30T22:59:59Z')),'2026-10-30');
  assert.equal(lagosDate(new Date('2026-10-30T23:00:00Z')),'2026-10-31');
  assert.equal(lagosDate(new Date('2026-06-30T23:30:00Z')),'2026-07-01');
  assert.equal(lagosDate(new Date('2026-12-31T23:00:00Z')),'2027-01-01');
  assert.equal(seasonFor(new Date('2026-12-25T00:00:00Z')).key,'christmas');
});

test('rejects invalid dates and years outside the supported range',()=>{
  assert.throws(()=>seasonFor('2026-02-30'),RangeError);
  assert.throws(()=>seasonFor('30/10/2026'),TypeError);
  assert.throws(()=>westernEaster(MIN_YEAR-1),RangeError);
  assert.throws(()=>westernEaster(MAX_YEAR+1),RangeError);
  assert.throws(()=>westernEaster(2026.5),RangeError);
  assert.throws(()=>liturgicalYear('2026'),RangeError);
});
