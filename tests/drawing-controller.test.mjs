import test from 'node:test';
import assert from 'node:assert/strict';
import {closeRing,validBoundary} from '../src/core.mjs';
import {createDrawingController} from '../src/drawing-controller.mjs';

function setup(){
  const drafts=[],commits=[],cancellations=[],statuses=[];
  const controller=createDrawingController({
    closeRing,
    validBoundary,
    onDraft:(points,mode)=>drafts.push({points,mode}),
    onCommit:(mode,ring)=>commits.push({mode,ring}),
    onCancel:mode=>cancellations.push(mode),
    onStatus:message=>statuses.push(message)
  });
  return {controller,drafts,commits,cancellations,statuses};
}

function triangle(controller){
  controller.add([-79.38,43.65]);
  controller.add([-79.37,43.65]);
  controller.add([-79.37,43.66]);
}

function keyEvent(overrides={}){
  return {
    key:'Enter',code:'Enter',target:null,defaultPrevented:false,
    preventDefault(){this.defaultPrevented=true;},
    ...overrides
  };
}

for(const [name,event] of [
  ['Enter',{key:'Enter',code:'Enter'}],
  ['NumpadEnter',{key:'Enter',code:'NumpadEnter'}]
]){
  test(`${name} finishes the active boundary and closes its ring`,()=>{
    const {controller,commits,statuses}=setup();
    controller.begin('site');triangle(controller);
    const input=keyEvent(event);

    const result=controller.handleKey(input);

    assert.equal(input.defaultPrevented,true);
    assert.deepEqual(result,{ok:true,mode:'site',ring:[[-79.38,43.65],[-79.37,43.65],[-79.37,43.66],[-79.38,43.65]]});
    assert.deepEqual(commits,[{mode:'site',ring:result.ring}]);
    assert.equal(statuses.at(-1),'Site boundary completed.');
    assert.deepEqual(controller.state(),{mode:null,points:[]});
  });
}

test('right-click prevents the map context menu and finishes an active building',()=>{
  const {controller,commits,statuses}=setup();
  controller.begin('building');triangle(controller);
  const event=keyEvent({key:undefined,code:undefined});

  const result=controller.handleContextMenu(event);

  assert.equal(event.defaultPrevented,true);
  assert.equal(result.ok,true);
  assert.equal(result.mode,'building');
  assert.deepEqual(commits,[{mode:'building',ring:result.ring}]);
  assert.equal(statuses.at(-1),'Building boundary completed.');
});

test('Backspace prevents browser navigation and removes the last active point',()=>{
  const {controller,drafts}=setup();
  controller.begin('site');triangle(controller);
  const event=keyEvent({key:'Backspace',code:'Backspace'});

  const result=controller.handleKey(event);

  assert.equal(event.defaultPrevented,true);
  assert.deepEqual(result,[ -79.37,43.66 ]);
  assert.deepEqual(controller.state(),{mode:'site',points:[[-79.38,43.65],[-79.37,43.65]]});
  assert.deepEqual(drafts.at(-1),{mode:'site',points:[[-79.38,43.65],[-79.37,43.65]]});
});

test('Escape cancels the active draft',()=>{
  const {controller,cancellations}=setup();
  controller.begin('site');triangle(controller);
  const event=keyEvent({key:'Escape',code:'Escape'});

  const result=controller.handleKey(event);

  assert.equal(event.defaultPrevented,true);
  assert.equal(result,true);
  assert.deepEqual(cancellations,['site']);
  assert.deepEqual(controller.state(),{mode:null,points:[]});
});

test('inactive context menus remain untouched',()=>{
  const {controller,commits}=setup();
  const event=keyEvent({key:undefined,code:undefined});

  assert.equal(controller.handleContextMenu(event),undefined);
  assert.equal(event.defaultPrevented,false);
  assert.deepEqual(commits,[]);
});

test('finishing with two points returns a precise error and preserves the draft',()=>{
  const {controller,commits,statuses}=setup();
  controller.begin('site');
  controller.add([-79.38,43.65]);controller.add([-79.37,43.65]);

  const result=controller.finish();

  assert.deepEqual(result,{ok:false,message:'Add at least 3 distinct corners before finishing.'});
  assert.deepEqual(controller.state(),{mode:'site',points:[[-79.38,43.65],[-79.37,43.65]]});
  assert.deepEqual(commits,[]);
  assert.equal(statuses.at(-1),result.message);
});

test('finishing a self-intersecting boundary explains the crossing and preserves the draft',()=>{
  const {controller,commits,statuses}=setup();
  const bowTie=[[-79.38,43.65],[-79.36,43.67],[-79.38,43.67],[-79.36,43.65]];
  controller.begin('building');bowTie.forEach(point=>controller.add(point));

  const result=controller.finish();

  assert.deepEqual(result,{ok:false,message:'Boundary corners must be distinct and edges cannot cross.'});
  assert.deepEqual(controller.state(),{mode:'building',points:bowTie});
  assert.deepEqual(commits,[]);
  assert.equal(statuses.at(-1),result.message);
});

test('public undo and finish methods drive the same draft and commit state used by commands',()=>{
  const {controller,commits}=setup();
  controller.begin('site');triangle(controller);
  assert.deepEqual(controller.undo(),[-79.37,43.66]);
  controller.add([-79.36,43.66]);

  const result=controller.finish();

  assert.equal(result.ok,true);
  assert.deepEqual(commits,[{mode:'site',ring:result.ring}]);
  assert.deepEqual(controller.state(),{mode:null,points:[]});
});

test('modified, composing, repeated, and text-entry key events do not hijack drawing',()=>{
  const {controller,commits}=setup();
  controller.begin('site');triangle(controller);
  const textInput={matches:selector=>selector.includes('input')};
  const nestedEditor={matches:()=>false,closest:selector=>selector.includes('contenteditable')?{}:null};
  const events=[
    keyEvent({ctrlKey:true}),keyEvent({metaKey:true}),keyEvent({altKey:true}),keyEvent({shiftKey:true}),
    keyEvent({isComposing:true}),keyEvent({repeat:true}),keyEvent({target:textInput}),
    keyEvent({key:'Backspace',code:'Backspace',target:textInput}),keyEvent({target:nestedEditor})
  ];

  for(const event of events)assert.equal(controller.handleKey(event),undefined);

  assert.ok(events.every(event=>!event.defaultPrevented));
  assert.deepEqual(commits,[]);
  assert.equal(controller.state().points.length,3);
});

test('keyboard commands leave native activation to interactive controls',()=>{
  const controls=['button','a[href]','input','textarea','select','summary','[contenteditable]','[role="button"]','[tabindex]'];
  for(const control of controls){
    const {controller,commits}=setup();
    controller.begin('site');triangle(controller);
    const event=keyEvent({code:control==='button'?'NumpadEnter':'Enter',target:{matches:selector=>selector.includes(control),closest:()=>null}});

    assert.equal(controller.handleKey(event),undefined,control);
    assert.equal(event.defaultPrevented,false,control);
    assert.deepEqual(commits,[],control);
    assert.equal(controller.state().points.length,3,control);
  }
});

test('finish returns a stable failure and preserves the draft when commit throws',()=>{
  const drafts=[];
  const controller=createDrawingController({
    closeRing,validBoundary,
    onDraft:(points,mode)=>drafts.push({points,mode}),
    onCommit:()=>{throw Error('storage failed');}
  });
  controller.begin('site');triangle(controller);
  const before=controller.state();

  const result=controller.finish();

  assert.deepEqual(result,{ok:false,message:'Drawing could not be completed. The current draft is still active.'});
  assert.deepEqual(controller.state(),before);
  assert.deepEqual(drafts.at(-1),before);
});

test('finish does not commit or clear when draft cleanup throws',()=>{
  const commits=[];
  let rejectEmpty=false;
  const controller=createDrawingController({
    closeRing,validBoundary,
    onDraft:points=>{if(rejectEmpty&&points.length===0)throw Error('layer removal failed');},
    onCommit:(mode,ring)=>commits.push({mode,ring})
  });
  controller.begin('building');triangle(controller);
  rejectEmpty=true;
  const before=controller.state();

  const result=controller.finish();

  assert.deepEqual(result,{ok:false,message:'Drawing could not be completed. The current draft is still active.'});
  assert.deepEqual(controller.state(),before);
  assert.deepEqual(commits,[]);
});

test('draft callback failures roll back add and undo transitions',()=>{
  let rejectLength=2;
  const controller=createDrawingController({
    closeRing,validBoundary,
    onDraft:points=>{if(points.length===rejectLength)throw Error('draft render failed');}
  });
  controller.begin('site');
  controller.add([-79.38,43.65]);

  assert.equal(controller.add([-79.37,43.65]),undefined);
  assert.deepEqual(controller.state(),{mode:'site',points:[[-79.38,43.65]]});
  rejectLength=0;
  assert.equal(controller.undo(),undefined);
  assert.deepEqual(controller.state(),{mode:'site',points:[[-79.38,43.65]]});
});

test('cancel and replacement callback failures preserve the active draft',()=>{
  let rejectCancel=true;
  const controller=createDrawingController({
    closeRing,validBoundary,
    onCancel:()=>{if(rejectCancel)throw Error('cleanup failed');}
  });
  controller.begin('site');triangle(controller);
  const before=controller.state();

  assert.deepEqual(controller.begin('building'),before);
  assert.deepEqual(controller.state(),before);
  assert.equal(controller.cancel(),false);
  assert.deepEqual(controller.state(),before);

  rejectCancel=false;
  assert.deepEqual(controller.begin('building'),{mode:'building',points:[]});
});

test('status callback failures never change finish results or core state',()=>{
  const commits=[];
  const controller=createDrawingController({
    closeRing,validBoundary,
    onCommit:(mode,ring)=>commits.push({mode,ring}),
    onStatus:()=>{throw Error('status display failed');}
  });
  controller.begin('site');triangle(controller);

  const result=controller.finish();

  assert.deepEqual(result,{ok:true,mode:'site',ring:[[-79.38,43.65],[-79.37,43.65],[-79.37,43.66],[-79.38,43.65]]});
  assert.deepEqual(commits,[{mode:'site',ring:result.ring}]);
  assert.deepEqual(controller.state(),{mode:null,points:[]});
});
