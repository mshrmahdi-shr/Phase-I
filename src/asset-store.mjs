const DATABASE_VERSION=1;
const ASSET_STORE='assets';
const METADATA_STORE='metadata';
const STORES=[ASSET_STORE,METADATA_STORE];
const MAX_ASSET_BYTES=16_000_000;
const MAX_DECODED_PIXELS=16_000_000;
const QUOTA_MESSAGE='Asset storage is full. Export a backup before adding more files.';

function isPlainObject(value){
  if(!value||typeof value!=='object'||Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function assetId(value,label='Asset ID'){
  if(typeof value!=='string'||!value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function positiveInteger(value,label){
  if(!Number.isSafeInteger(value)||value<=0) throw new Error(`${label} must be a positive whole number.`);
  return value;
}

function validateMetadata(value){
  if(!isPlainObject(value)) throw new Error('Asset metadata must be a plain object.');
  const id=assetId(value.id);
  if(typeof value.kind!=='string'||!value.kind.trim()) throw new Error('Asset kind must be a non-empty string.');
  if(typeof value.mime!=='string'||!value.mime.trim()) throw new Error('Asset MIME type must be a non-empty string.');
  if(!Number.isSafeInteger(value.size)||value.size<=0) throw new Error('Asset size must be a positive whole number.');
  if(value.size>MAX_ASSET_BYTES) throw new Error('Asset size exceeds the 16 MB safety limit.');
  const width=positiveInteger(value.width,'Asset width');
  const height=positiveInteger(value.height,'Asset height');
  if(width>Math.floor(MAX_DECODED_PIXELS/height)) throw new Error('Asset dimensions exceed the 16 million decoded pixel safety limit.');
  if(typeof value.sha256!=='string'||!value.sha256.trim()) throw new Error('Asset SHA-256 value must be a non-empty string.');
  if(typeof value.createdAt!=='string'||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.createdAt)||
    Number.isNaN(Date.parse(value.createdAt))) throw new Error('Asset createdAt must be an ISO timestamp.');
  return {
    id,kind:value.kind,mime:value.mime,size:value.size,width,height,
    sha256:value.sha256,createdAt:value.createdAt
  };
}

function validateAsset(value){
  if(!isPlainObject(value)) throw new Error('Asset must include metadata and a Blob.');
  const metadata=validateMetadata(value.metadata);
  if(!(value.blob instanceof Blob)) throw new Error('Asset data must be a Blob.');
  if(value.blob.size!==metadata.size) throw new Error('Asset metadata size does not match the Blob size.');
  if(value.blob.type!==metadata.mime) throw new Error('Asset metadata MIME type does not match the Blob MIME type.');
  return {metadata,blob:value.blob};
}

function errorFrom(value){
  if(value?.target?.error) return value.target.error;
  return value;
}

function storageError(value,id){
  const error=errorFrom(value);
  if(error?.name==='QuotaExceededError') return new Error(QUOTA_MESSAGE,{cause:error});
  if(error?.name==='ConstraintError') return new Error(`An asset with ID "${id}" already exists.`,{cause:error});
  return error instanceof Error?error:new Error('Asset storage operation failed.');
}

function requestResult(request,onError){
  return new Promise((resolve,reject)=>{
    request.onsuccess=()=>resolve(request.result);
    request.onerror=event=>{
      const error=errorFrom(event);
      onError?.(error);
      reject(error);
    };
  });
}

function transactionCompletion(transaction,onError){
  return new Promise((resolve,reject)=>{
    transaction.oncomplete=()=>resolve();
    transaction.onerror=event=>onError?.(errorFrom(event));
    transaction.onabort=event=>reject(errorFrom(event)||transaction.error||new Error('Asset storage transaction was aborted.'));
  });
}

function validateIdList(value,label){
  if(!value||typeof value==='string'||typeof value[Symbol.iterator]!=='function') throw new Error(`${label} must be an iterable of asset IDs.`);
  const result=[];
  const seen=new Set();
  for(const id of value){
    assetId(id,label.slice(0,-1));
    if(seen.has(id)) throw new Error(`${label} must not contain duplicate IDs.`);
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function createAssetStore({indexedDB=globalThis.indexedDB,databaseName='phase-i-assets-v1'}={}){
  if(!indexedDB||typeof indexedDB.open!=='function') throw new Error('IndexedDB is unavailable.');
  if(typeof databaseName!=='string'||!databaseName.trim()) throw new Error('Asset database name must be a non-empty string.');
  let databaseAttempt;
  let databaseVersion=DATABASE_VERSION;

  function openDatabase(){
    if(databaseAttempt) return databaseAttempt.promise;
    const attempt={abandoned:false,settled:false};
    attempt.promise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(databaseName,databaseVersion);
      request.onupgradeneeded=()=>{
        const database=request.result;
        if(!database.objectStoreNames.contains(ASSET_STORE)) database.createObjectStore(ASSET_STORE,{keyPath:'id'});
        if(!database.objectStoreNames.contains(METADATA_STORE)) database.createObjectStore(METADATA_STORE,{keyPath:'id'});
      };
      request.onsuccess=()=>{
        const database=request.result;
        databaseVersion=Math.max(databaseVersion,database.version);
        if(attempt.abandoned||databaseAttempt!==attempt){
          database.close();
          if(!attempt.settled){
            attempt.settled=true;
            resolve(database);
          }
          return;
        }
        database.onversionchange=event=>{
          if(Number.isSafeInteger(event.newVersion)) databaseVersion=Math.max(DATABASE_VERSION,event.newVersion);
          database.close();
          attempt.abandoned=true;
          if(databaseAttempt===attempt) databaseAttempt=undefined;
        };
        attempt.settled=true;
        resolve(database);
      };
      request.onerror=event=>{
        if(attempt.settled) return;
        attempt.settled=true;
        attempt.abandoned=true;
        if(databaseAttempt===attempt) databaseAttempt=undefined;
        reject(storageError(event));
      };
      request.onblocked=()=>{
        if(attempt.settled) return;
        attempt.settled=true;
        attempt.abandoned=true;
        if(databaseAttempt===attempt) databaseAttempt=undefined;
        reject(new Error('Asset database upgrade is blocked by another open page.'));
      };
    });
    databaseAttempt=attempt;
    attempt.promise.catch(()=>{
      attempt.abandoned=true;
      if(databaseAttempt===attempt) databaseAttempt=undefined;
    });
    return attempt.promise;
  }

  async function mutate(id,operation){
    const database=await openDatabase();
    let recordedError;
    let result;
    let transaction;
    let completion;
    try{
      transaction=database.transaction(STORES,'readwrite');
      completion=transactionCompletion(transaction,error=>{recordedError??=error;});
      const watch=request=>{
        request.onerror=event=>{recordedError??=errorFrom(event);};
        return request;
      };
      operation(transaction,watch,value=>{result=value;});
      await completion;
      return result;
    }catch(error){
      try{transaction?.abort();}catch{}
      try{await completion;}catch{}
      const primaryError=['QuotaExceededError','ConstraintError'].includes(error?.name)?error:recordedError||error;
      throw storageError(primaryError,id);
    }
  }

  async function readAll(){
    const database=await openDatabase();
    const transaction=database.transaction(STORES,'readonly');
    let recordedError;
    const completion=transactionCompletion(transaction,error=>{recordedError??=error;});
    try{
      const [metadata,assets]=await Promise.all([
        requestResult(transaction.objectStore(METADATA_STORE).getAll(),error=>{recordedError??=error;}),
        requestResult(transaction.objectStore(ASSET_STORE).getAll(),error=>{recordedError??=error;})
      ]);
      await completion;
      const assetsById=new Map(assets.map(value=>[value.id,value.blob]));
      return metadata.map(value=>{
        const blob=assetsById.get(value.id);
        if(!(blob instanceof Blob)) throw new Error(`Asset "${value.id}" is incomplete.`);
        return {metadata:value,blob};
      });
    }catch(error){
      throw storageError(recordedError||error);
    }
  }

  return {
    async put(value){
      const asset=validateAsset(value);
      return mutate(asset.metadata.id,(transaction,watch)=>{
        watch(transaction.objectStore(ASSET_STORE).add({id:asset.metadata.id,blob:asset.blob}));
        watch(transaction.objectStore(METADATA_STORE).add(asset.metadata));
      });
    },

    async get(id){
      assetId(id);
      const database=await openDatabase();
      const transaction=database.transaction(STORES,'readonly');
      let recordedError;
      const completion=transactionCompletion(transaction,error=>{recordedError??=error;});
      try{
        const [metadata,asset]=await Promise.all([
          requestResult(transaction.objectStore(METADATA_STORE).get(id),error=>{recordedError??=error;}),
          requestResult(transaction.objectStore(ASSET_STORE).get(id),error=>{recordedError??=error;})
        ]);
        await completion;
        if(metadata===undefined&&asset===undefined) return null;
        if(metadata===undefined||!(asset?.blob instanceof Blob)) throw new Error(`Asset "${id}" is incomplete.`);
        return {metadata,blob:asset.blob};
      }catch(error){
        throw storageError(recordedError||error,id);
      }
    },

    async delete(id){
      assetId(id);
      return mutate(id,(transaction,watch,setResult)=>{
        const metadata=transaction.objectStore(METADATA_STORE);
        const assets=transaction.objectStore(ASSET_STORE);
        const request=watch(metadata.get(id));
        request.onsuccess=()=>{
          const exists=request.result!==undefined;
          if(exists){
            watch(metadata.delete(id));
            watch(assets.delete(id));
          }
          setResult(exists);
        };
      });
    },

    async list({kind}={}){
      if(kind!==undefined&&(typeof kind!=='string'||!kind.trim())) throw new Error('Asset kind must be a non-empty string.');
      const values=await readAll();
      return kind===undefined?values:values.filter(value=>value.metadata.kind===kind);
    },

    async replace({removeIds,put}={}){
      const ids=validateIdList(removeIds,'Removal IDs');
      const asset=validateAsset(put);
      return mutate(asset.metadata.id,(transaction,watch)=>{
        const assets=transaction.objectStore(ASSET_STORE);
        const metadata=transaction.objectStore(METADATA_STORE);
        for(const id of ids){
          watch(assets.delete(id));
          watch(metadata.delete(id));
        }
        watch(assets.add({id:asset.metadata.id,blob:asset.blob}));
        watch(metadata.add(asset.metadata));
      });
    },

    async deleteUnreferenced(referencedIds){
      const referenced=new Set(validateIdList(referencedIds,'Referenced IDs'));
      return mutate(undefined,(transaction,watch,setResult)=>{
        const metadata=transaction.objectStore(METADATA_STORE);
        const assets=transaction.objectStore(ASSET_STORE);
        let deleted=0;
        const request=watch(metadata.openCursor());
        request.onsuccess=()=>{
          const cursor=request.result;
          if(!cursor){
            setResult(deleted);
            return;
          }
          if(!referenced.has(cursor.primaryKey)){
            watch(cursor.delete());
            watch(assets.delete(cursor.primaryKey));
            deleted++;
          }
          cursor.continue();
        };
      });
    },

    async estimate(){
      const values=await readAll();
      const storage=await globalThis.navigator?.storage?.estimate?.();
      return {
        assetCount:values.length,
        totalBytes:values.reduce((total,value)=>total+value.blob.size,0),
        usage:storage?.usage??null,
        quota:storage?.quota??null
      };
    },

    async close(){
      const current=databaseAttempt;
      databaseAttempt=undefined;
      if(!current) return;
      current.abandoned=true;
      try{(await current.promise).close();}catch{}
    }
  };
}
