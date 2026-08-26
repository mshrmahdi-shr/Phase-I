# Company Profile, Template, and Asset Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a required reusable company profile with logo, shareable template backup, IndexedDB asset storage, and company branding on every existing output.

**Architecture:** Keep project metadata small and synchronous while storing binary logo/image assets in a versioned IndexedDB repository. Validate company data in pure modules, inspect imports before mutation, and pass an immutable company snapshot into preview/PDF/DXF output code.

**Tech Stack:** Browser ES modules, IndexedDB, JSZip 3.10.1, Leaflet 1.9.4, jsPDF 4.2.1, Node >=22, node:test, jsdom, fake-indexeddb for storage tests.

**Spec:** `docs/superpowers/specs/2026-08-26-historical-imagery-cad-company-template-design.md`

## Global Constraints

- Work only in `mshrmahdi-shr/Phase-I`; preserve legacy project JSON imports and existing A-E behavior.
- No account, cloud storage, backend, paid API, HTML scraping, or executable SVG.
- Required profile data: company name, address, phone, email, website, and a decoded PNG/JPEG logo. Prepared-by and reviewed-by defaults are optional.
- Store binary assets in IndexedDB; localStorage may hold only lightweight IDs/metadata.
- Company-template import is previewed and explicitly confirmed before replacing persistent state.
- Every output must use one immutable company-profile snapshot; missing required profile data blocks output with field-specific guidance.
- New projects keep `projectNo === ''`; `AB-12345` is only the placeholder/example.
- Every mutation and import is atomic. Never replace the current valid profile with partial or invalid data.

---

## File Structure

- Create `src/company-profile.mjs`: schema, normalization, validation, safe snapshot creation.
- Create `src/asset-store.mjs`: versioned IndexedDB repository and transactional asset methods.
- Create `src/company-template.mjs`: `.phasei-template.zip` inspect/export/import logic.
- Create `src/company-ui.mjs`: company dialog controller with confirmation and logo preview.
- Create `tests/company-profile.test.mjs`, `tests/asset-store.test.mjs`, `tests/company-template.test.mjs`, `tests/company-ui.test.mjs`.
- Modify `src/core.mjs`: schema migration and project company-profile snapshot compatibility.
- Modify `src/pdf-export.mjs`, `app.js`, `index.html`, `styles.css`, `print-preflight.mjs`, `src/print-validation.mjs`: required profile wiring and branding.
- Modify `scripts/build-site.mjs`, `tests/build.test.mjs`, `package.json`, `pnpm-lock.yaml`: test-only fake IndexedDB dependency and staging checks.

### Task 1: Company profile schema and project-number example

**Files:**
- Create: `src/company-profile.mjs`
- Create: `tests/company-profile.test.mjs`
- Modify: `src/core.mjs`
- Modify: `tests/core.test.mjs`
- Modify: `index.html`
- Modify: `tests/ui.test.mjs`

**Interfaces:**
- Produces: `emptyCompanyProfile()`, `normalizeCompanyProfile(value)`, `validateCompanyProfile(value, {requireLogo=true})`, `snapshotCompanyProfile(value)`.
- Profile shape:

```js
{
  schemaVersion: 1,
  id: 'uuid',
  companyName: '', address: '', phone: '', email: '', website: '',
  preparedBy: '', reviewedBy: '',
  logoAssetId: '', logoMime: '', logoWidth: 0, logoHeight: 0,
  logoPlacement: {align: 'center', scale: 1},
  updatedAt: 'ISO timestamp'
}
```

- [ ] **Step 1: Write failing validation and migration tests**

```js
test('company profile requires contact fields and a safe decoded logo',()=>{
  const profile={...emptyCompanyProfile(),companyName:'ABC Engineering'};
  assert.deepEqual(validateCompanyProfile(profile).map(x=>x.field),['address','phone','email','website','logoAssetId']);
  assert.throws(()=>normalizeCompanyProfile({...profile,logoMime:'image/svg+xml'}),/PNG or JPEG/i);
});

test('new project keeps project number blank and restores a profile snapshot',()=>{
  const p=createProject();
  assert.equal(p.projectNo,'');
  const validProfile={...emptyCompanyProfile(),companyName:'ABC Engineering',address:'1 Main St',
    phone:'416-555-0100',email:'maps@example.com',website:'https://example.com',
    logoAssetId:'logo-1',logoMime:'image/png',logoWidth:400,logoHeight:160};
  p.companyProfileSnapshot=snapshotCompanyProfile(validProfile);
  assert.equal(restoreProject(p).companyProfileSnapshot.companyName,'ABC Engineering');
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/company-profile.test.mjs tests/core.test.mjs tests/ui.test.mjs`

Expected: FAIL because `src/company-profile.mjs` and `AB-12345` placeholder behavior do not exist.

- [ ] **Step 3: Implement pure profile functions and schema migration**

Implement exact exports:

```js
export function emptyCompanyProfile(){/* return complete shape */}
export function normalizeCompanyProfile(value){/* copy known text fields; reject arrays, unsafe MIME, dimensions, placement */}
export function validateCompanyProfile(value,{requireLogo=true}={}){/* return [{field,message}] */}
export function snapshotCompanyProfile(value){/* structuredClone normalized profile without executable values */}
```

Set `schemaVersion=4` in restored projects, accept legacy absent `companyProfileSnapshot` as `null`, and validate a present snapshot. Change only the project-number placeholder in `index.html` to `AB-12345`.

- [ ] **Step 4: Run focused and full tests**

Run: `pnpm exec node --test --test-isolation=none tests/company-profile.test.mjs tests/core.test.mjs tests/ui.test.mjs`

Run: `pnpm test`

Expected: all tests PASS; legacy JSON fixtures still restore.

- [ ] **Step 5: Commit the schema slice**

```bash
git add -- src/company-profile.mjs src/core.mjs index.html tests/company-profile.test.mjs tests/core.test.mjs tests/ui.test.mjs
git commit -m "Add company profile schema and project number example"
```

### Task 2: Transactional IndexedDB asset repository

**Files:**
- Create: `src/asset-store.mjs`
- Create: `tests/asset-store.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: asset metadata `{id,kind,mime,size,width,height,sha256,createdAt}` and `Blob`.
- Produces:

```js
export function createAssetStore({indexedDB,databaseName='phase-i-assets-v1'}={});
// async methods: put({metadata,blob}), get(id), delete(id), list({kind}),
// replace({removeIds,put}), deleteUnreferenced(referencedIds), estimate()
```

- [ ] **Step 1: Install the test-only IndexedDB implementation**

Run: `pnpm add --save-dev --save-exact fake-indexeddb`

Expected: package and lockfile change; no runtime browser dependency is introduced.

- [ ] **Step 2: Write failing repository tests**

```js
test('replace is atomic when a new asset write fails',async()=>{
  const store=createAssetStore({indexedDB:new IDBFactory(),databaseName:`test-${crypto.randomUUID()}`});
  const validLogo={metadata:{id:'logo-1',kind:'company-logo',mime:'image/png',size:3,width:1,height:1,
    sha256:'valid-hash',createdAt:'2026-08-26T00:00:00Z'},blob:new Blob(['png'],{type:'image/png'})};
  const invalidAsset={metadata:{...validLogo.metadata,id:'bad',size:-1},blob:validLogo.blob};
  await store.put(validLogo);
  await assert.rejects(()=>store.replace({removeIds:[validLogo.metadata.id],put:invalidAsset}));
  assert.equal((await store.get(validLogo.metadata.id)).metadata.sha256,validLogo.metadata.sha256);
});
```

The test imports `IDBFactory` from `fake-indexeddb` and uses Web Crypto from Node 22.

Cover duplicate IDs, Blob/MIME mismatch, size and decoded pixel limits, quota errors, missing IDs, list-by-kind, and unreferenced cleanup.

- [ ] **Step 3: Run the asset test and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/asset-store.test.mjs`

Expected: FAIL because the repository is absent.

- [ ] **Step 4: Implement the repository with one database transaction per mutation**

Use object stores `assets` keyed by ID and `metadata` keyed by ID. Store the Blob and metadata in the same transaction. Map browser `QuotaExceededError` to `Asset storage is full. Export a backup before adding more files.` Close failed transactions and expose a `close()` method for tests.

- [ ] **Step 5: Run focused/full tests and commit**

Run: `pnpm exec node --test --test-isolation=none tests/asset-store.test.mjs`

Run: `pnpm test`

```bash
git add -- src/asset-store.mjs tests/asset-store.test.mjs package.json pnpm-lock.yaml
git commit -m "Add transactional browser asset storage"
```

### Task 3: Shareable company template ZIP

**Files:**
- Create: `src/company-template.mjs`
- Create: `tests/company-template.test.mjs`

**Interfaces:**
- Consumes: validated profile, asset store, JSZip-compatible constructor.
- Produces:

```js
export async function exportCompanyTemplate({profile,assetStore,Zip=globalThis.JSZip});
// => {blob,filename:'company-name.phasei-template.zip'}
export async function inspectCompanyTemplate(file,{Zip=globalThis.JSZip}={});
// => {profile,logoBlob,logoMetadata,warnings}; no persistent mutation
export async function commitCompanyTemplate(candidate,{assetStore});
// => persisted normalized profile
```

- [ ] **Step 1: Write failing round-trip and hostile ZIP tests**

Create an in-memory template, export it, inspect it, and assert identical normalized fields and logo hash. Reject absolute paths, `../`, encoded traversal, duplicate normalized paths, unexpected executable files, multiple logos, decompressed size above 8 MiB, invalid JSON, unsupported schema, and SVG logos.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/company-template.test.mjs`

- [ ] **Step 3: Implement deterministic template generation and inspection**

Write only `template.json`, one `logo.png`/`logo.jpg`, and `README.txt`. Sort JSON keys through an explicit serializer, compute/verify SHA-256 with Web Crypto, and never call `commitCompanyTemplate` inside `inspectCompanyTemplate`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec node --test --test-isolation=none tests/company-template.test.mjs tests/company-profile.test.mjs tests/asset-store.test.mjs`

Run: `pnpm test`

```bash
git add -- src/company-template.mjs tests/company-template.test.mjs
git commit -m "Add shareable company profile templates"
```

### Task 4: Company profile UI and branded existing outputs

**Files:**
- Create: `src/company-ui.mjs`
- Create: `tests/company-ui.test.mjs`
- Modify: `app.js`
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `src/pdf-export.mjs`
- Modify: `print-preflight.mjs`
- Modify: `src/print-validation.mjs`
- Modify: `tests/pdf-export.test.mjs`
- Modify: `tests/print-validation.test.mjs`
- Modify: `tests/ui.test.mjs`
- Modify: `scripts/build-site.mjs`
- Modify: `tests/build.test.mjs`

**Interfaces:**
- Consumes: Task 1-3 modules and `assetStore`.
- Produces:

```js
export function createCompanyProfileDialog({document,assetStore,loadProfile,saveProfile,onChanged,Zip});
// methods: open(), close(), refresh(), destroy()
```

- `exportCombinedPdf` receives required `companyProfile` and `companyLogoDataUrl` arguments.

- [ ] **Step 1: Add failing UI and output tests**

Test first-run dialog, field-level errors, decoded PNG/JPEG validation, import preview without mutation, explicit replace confirmation, export template download/revoke, edit/reopen persistence, and keyboard focus return. Extend PDF tests to assert company name exists in extracted text and a missing logo/profile rejects before map composition.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm exec node --test --test-isolation=none tests/company-ui.test.mjs tests/pdf-export.test.mjs tests/print-validation.test.mjs tests/ui.test.mjs`

- [ ] **Step 3: Implement accessible dialog and first-run gate**

Add header buttons **Edit Company Profile**, **Export Company Template**, **Import Company Template** and a modal with labeled fields and logo preview. Decode the image before saving, enforce 4 MiB/16 megapixel limits, store the Blob through `assetStore`, and persist only profile metadata/asset ID in localStorage. Keep the old profile until the replacement transaction succeeds.

- [ ] **Step 4: Brand A3 preview, combined PDF, and existing DXF**

Render the company logo and contact text in the current title block. Pass a frozen snapshot into each output. Add company readiness to print/export preflight. Put company/title text on separate DXF layers without attempting to vectorize the raster logo.

- [ ] **Step 5: Update staging and run all verification**

Ensure new modules are copied/versioned by the existing recursive `src` staging. Add build assertions that the company modules are present and no template/project user data appears in `_site`.

Run: `pnpm test`

Run: `pnpm build`

Run: `git diff --check`

- [ ] **Step 6: Browser-check and commit**

Serve `_site`; create a public test profile, reload, edit it, export/import its template, inspect A3 preview and one actual PDF, and verify missing profile blocks output. Check mobile dialog scrolling and console errors.

```bash
git add -- app.js index.html styles.css print-preflight.mjs src/company-ui.mjs src/pdf-export.mjs src/print-validation.mjs scripts/build-site.mjs tests/company-ui.test.mjs tests/pdf-export.test.mjs tests/print-validation.test.mjs tests/ui.test.mjs tests/build.test.mjs
git commit -m "Require reusable company branding on outputs"
```

## Plan Self-Review

- Spec coverage: required profile, PNG/JPEG logo, local persistence, cache-clear recovery, shareable template, project snapshot compatibility, branding, output gate, `AB-12345`, and security all map to Tasks 1-4.
- Type consistency: profile field names and template interfaces are defined once and reused by UI/PDF code.
- Dependency boundary: fake-indexeddb is test-only; JSZip remains the existing staged browser library.
- Rollback: each task is independently testable and committed; no historical imagery or CAD packaging is introduced in this plan.
