import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyCompanyProfile,
  normalizeCompanyProfile,
  snapshotCompanyProfile,
  validateCompanyProfile
} from '../src/company-profile.mjs';

test('company profile requires contact fields and a safe decoded logo',()=>{
  const profile={...emptyCompanyProfile(),companyName:'ABC Engineering'};
  assert.deepEqual(validateCompanyProfile(profile).map(x=>x.field),['address','phone','email','website','logoAssetId']);
  assert.throws(()=>normalizeCompanyProfile({...profile,logoMime:'image/svg+xml'}),/PNG or JPEG/i);
});

test('company profile normalization rejects malformed logo metadata and placement',()=>{
  const profile=emptyCompanyProfile();
  assert.throws(()=>normalizeCompanyProfile([]),/plain object/i);
  assert.throws(()=>normalizeCompanyProfile({...profile,logoAssetId:'logo-1',logoMime:'image/png',logoWidth:-1,logoHeight:160}),/dimensions/i);
  assert.throws(()=>normalizeCompanyProfile({...profile,logoPlacement:{align:'top',scale:1}}),/alignment/i);
  assert.throws(()=>normalizeCompanyProfile({...profile,logoPlacement:{align:'center',scale:0}}),/scale/i);
});

test('company profile normalization accepts ISO timestamps only',()=>{
  assert.throws(()=>normalizeCompanyProfile({...emptyCompanyProfile(),updatedAt:'August 26, 2026'}),/ISO timestamp/i);
});

test('profile snapshot contains only normalized data and does not share placement state',()=>{
  const profile={...emptyCompanyProfile(),companyName:'ABC Engineering',unknown:{script:'alert(1)'},logoPlacement:{align:'left',scale:1.25}};
  const snapshot=snapshotCompanyProfile(profile);
  assert.deepEqual(snapshot.logoPlacement,{align:'left',scale:1.25});
  assert.equal('unknown' in snapshot,false);
  profile.logoPlacement.align='right';
  assert.equal(snapshot.logoPlacement.align,'left');
});
