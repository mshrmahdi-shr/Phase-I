import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createAssetStore} from '../src/asset-store.mjs';

const created=[];

function asset(id,{kind='company-logo',mime='image/png',contents='png',width=1,height=1,size}={}){
  const blob=new Blob([contents],{type:mime});
  return {
    metadata:{
      id,kind,mime,size:size??blob.size,width,height,
      sha256:`hash-${id}`,createdAt:'2026-08-26T00:00:00Z'
    },
    blob
  };
}

function store(indexedDB=new IDBFactory()){
  const value=createAssetStore({indexedDB,databaseName:`test-${crypto.randomUUID()}`});
  created.push(value);
  return value;
}

function opened(request){
  return new Promise((resolve,reject)=>{
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}

test.after(async()=>{
  await Promise.all(created.map(value=>value.close()));
});

test('put stores metadata and its Blob together',async()=>{
  const repository=store();
  const logo=asset('logo-1');
  await repository.put(logo);

  const saved=await repository.get('logo-1');
  assert.deepEqual(saved.metadata,logo.metadata);
  assert.equal(saved.blob.type,'image/png');
  assert.equal(await saved.blob.text(),'png');
});

test('put rejects duplicate IDs without replacing the current asset',async()=>{
  const repository=store();
  await repository.put(asset('logo-1',{contents:'old'}));

  await assert.rejects(()=>repository.put(asset('logo-1',{contents:'new'})),/already exists/i);
  assert.equal(await (await repository.get('logo-1')).blob.text(),'old');
});

test('invalid metadata and Blobs are rejected before IndexedDB is opened',async()=>{
  let opens=0;
  const factory=new IDBFactory();
  const repository=store({open(...args){opens++;return factory.open(...args);}});
  const valid=asset('logo-1');

  await assert.rejects(()=>repository.put({metadata:{...valid.metadata,size:-1},blob:valid.blob}),/size/i);
  await assert.rejects(()=>repository.put({metadata:{...valid.metadata,size:16_000_001},blob:valid.blob}),/16 MB/i);
  await assert.rejects(()=>repository.put({metadata:{...valid.metadata,width:4001,height:4000},blob:valid.blob}),/16 million/i);
  await assert.rejects(()=>repository.put({metadata:{...valid.metadata,mime:'image/jpeg'},blob:valid.blob}),/MIME/i);
  await assert.rejects(()=>repository.put({metadata:{...valid.metadata,createdAt:'August 26, 2026'},blob:valid.blob}),/ISO timestamp/i);
  await assert.rejects(()=>repository.put({metadata:valid.metadata,blob:new Uint8Array([1,2,3])}),/Blob/i);
  assert.equal(opens,0);
});

test('put rejects metadata size that does not match the Blob',async()=>{
  const repository=store();
  const value=asset('logo-1');
  await assert.rejects(()=>repository.put({metadata:{...value.metadata,size:value.blob.size+1},blob:value.blob}),/does not match/i);
  assert.equal(await repository.get('logo-1'),null);
});

test('list can filter complete assets by kind',async()=>{
  const repository=store();
  await repository.put(asset('logo-1'));
  await repository.put(asset('map-1',{kind:'historical-image',contents:'map'}));

  const logos=await repository.list({kind:'company-logo'});
  assert.deepEqual(logos.map(value=>value.metadata.id),['logo-1']);
  assert.equal(await logos[0].blob.text(),'png');
  assert.deepEqual((await repository.list({})).map(value=>value.metadata.id),['logo-1','map-1']);
});

test('missing IDs are harmless to read and delete',async()=>{
  const repository=store();
  assert.equal(await repository.get('missing'),null);
  assert.equal(await repository.delete('missing'),false);
});

test('delete removes metadata and Blob in one mutation',async()=>{
  const repository=store();
  await repository.put(asset('logo-1'));
  assert.equal(await repository.delete('logo-1'),true);
  assert.equal(await repository.get('logo-1'),null);
});

test('replace atomically removes current assets and stores the replacement',async()=>{
  const repository=store();
  await repository.put(asset('logo-1'));
  await repository.replace({removeIds:['logo-1'],put:asset('logo-2',{contents:'replacement'})});

  assert.equal(await repository.get('logo-1'),null);
  assert.equal(await (await repository.get('logo-2')).blob.text(),'replacement');
});

test('replace is atomic when a new asset fails validation',async()=>{
  const repository=store();
  const validLogo=asset('logo-1');
  const invalidAsset={metadata:{...validLogo.metadata,id:'bad',size:-1},blob:validLogo.blob};
  await repository.put(validLogo);

  await assert.rejects(()=>repository.replace({removeIds:[validLogo.metadata.id],put:invalidAsset}));
  assert.equal((await repository.get(validLogo.metadata.id)).metadata.sha256,validLogo.metadata.sha256);
});

test('replace rolls back removals when the replacement ID already exists',async()=>{
  const repository=store();
  await repository.put(asset('logo-1',{contents:'current'}));
  await repository.put(asset('logo-2',{contents:'other'}));

  await assert.rejects(
    ()=>repository.replace({removeIds:['logo-1'],put:asset('logo-2',{contents:'collision'})}),
    /already exists/i
  );
  assert.equal(await (await repository.get('logo-1')).blob.text(),'current');
  assert.equal(await (await repository.get('logo-2')).blob.text(),'other');
});

test('deleteUnreferenced removes only assets outside the reference set',async()=>{
  const repository=store();
  await repository.put(asset('keep'));
  await repository.put(asset('remove-1'));
  await repository.put(asset('remove-2'));

  assert.equal(await repository.deleteUnreferenced(['keep']),2);
  assert.deepEqual((await repository.list({})).map(value=>value.metadata.id),['keep']);
});

test('quota failures provide backup guidance and leave current assets intact',async()=>{
  const factory=new IDBFactory();
  let failWrites=false;
  const indexedDB={
    open(...args){
      const request=factory.open(...args);
      request.addEventListener('success',()=>{
        const database=request.result;
        const transaction=database.transaction.bind(database);
        database.transaction=(storeNames,mode)=>{
          const tx=transaction(storeNames,mode);
          if(mode==='readwrite'&&failWrites){
            const objectStore=tx.objectStore.bind(tx);
            tx.objectStore=name=>{
              const value=objectStore(name);
              if(name==='assets') value.add=()=>{throw new DOMException('quota','QuotaExceededError');};
              return value;
            };
          }
          return tx;
        };
      });
      return request;
    }
  };
  const repository=store(indexedDB);
  await repository.put(asset('logo-1',{contents:'current'}));
  failWrites=true;

  await assert.rejects(
    ()=>repository.replace({removeIds:['logo-1'],put:asset('logo-2')}),
    {message:'Asset storage is full. Export a backup before adding more files.'}
  );
  assert.equal(await (await repository.get('logo-1')).blob.text(),'current');
  assert.equal(await repository.get('logo-2'),null);
});

test('estimate reports repository asset count and byte total',async()=>{
  const repository=store();
  await repository.put(asset('one',{contents:'123'}));
  await repository.put(asset('two',{contents:'4567'}));
  const estimate=await repository.estimate();
  assert.equal(estimate.assetCount,2);
  assert.equal(estimate.totalBytes,7);
});

test('versionchange closes and evicts the cached connection so later reads reopen',async()=>{
  const indexedDB=new IDBFactory();
  const databaseName=`test-${crypto.randomUUID()}`;
  const repository=createAssetStore({indexedDB,databaseName});
  created.push(repository);
  await repository.put(asset('logo-1'));

  const upgraded=await opened(indexedDB.open(databaseName,2));
  upgraded.close();

  assert.equal((await repository.get('logo-1')).metadata.id,'logo-1');
});

test('a blocked open that succeeds late closes its abandoned connection',async()=>{
  const factory=new IDBFactory();
  const databaseName=`test-${crypto.randomUUID()}`;
  const blocker=await opened(factory.open(databaseName,1));
  let resolveLate;
  let opens=0;
  const lateSuccess=new Promise(resolve=>{resolveLate=resolve;});
  const indexedDB={
    open(name,version){
      opens++;
      const request=factory.open(name,opens===1?2:version);
      if(opens===1) request.addEventListener('success',()=>resolveLate(request.result));
      return request;
    }
  };
  const repository=createAssetStore({indexedDB,databaseName});
  created.push(repository);

  await assert.rejects(()=>repository.get('missing'),/blocked/i);
  blocker.close();
  const abandonedDatabase=await lateSuccess;

  assert.throws(()=>abandonedDatabase.transaction('assets','readonly'),{name:'InvalidStateError'});
  assert.equal(await repository.get('missing'),null);
});

test('a synchronous open failure is evicted so a later operation can retry',async()=>{
  const factory=new IDBFactory();
  let attempts=0;
  const indexedDB={
    open(...args){
      attempts++;
      if(attempts===1) throw new DOMException('temporary open failure','UnknownError');
      return factory.open(...args);
    }
  };
  const repository=store(indexedDB);

  await assert.rejects(()=>repository.get('missing'),{name:'UnknownError'});
  assert.equal(await repository.get('missing'),null);
  assert.equal(attempts,2);
});
