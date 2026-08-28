const MIN_SINGULAR_RATIO=1e-12;
const EXTENSIONS=Object.freeze({png:'pgw',jpg:'jgw',jpeg:'jgw',tif:'tfw',tiff:'tfw'});

function fail(message){throw new Error(message);}

function finitePair(value,label){
  if(!Array.isArray(value)||value.length!==2||value.some(coordinate=>typeof coordinate!=='number'||!Number.isFinite(coordinate)))fail(`${label} corner must be an exact pair of finite coordinates.`);
  return value;
}

function positiveDimension(value,label){
  if(!Number.isSafeInteger(value)||value<=0)fail(`${label} dimension must be a positive safe integer.`);
  return value;
}

function finiteCoefficients(value){
  if(!Array.isArray(value)||value.length!==6||value.some(coefficient=>typeof coefficient!=='number'||!Number.isFinite(coefficient)))fail('World-file coefficients must contain exactly six finite numbers.');
  return value;
}

function validateAffine([A,D,B,E]){
  const scale=Math.max(Math.abs(A),Math.abs(D),Math.abs(B),Math.abs(E));
  if(!(scale>0)||!Number.isFinite(scale))fail('World-file affine geometry is degenerate or nonfinite.');
  const a=A/scale,d=D/scale,b=B/scale,e=E/scale;
  const determinant=a*e-b*d;
  const frobeniusSquared=a*a+d*d+b*b+e*e;
  const discriminant=Math.max(0,frobeniusSquared*frobeniusSquared-4*determinant*determinant);
  const largestEigenvalue=(frobeniusSquared+Math.sqrt(discriminant))/2;
  const singularRatio=Math.abs(determinant)/largestEigenvalue;
  if(!Number.isFinite(singularRatio)||singularRatio<=MIN_SINGULAR_RATIO)fail('World-file affine geometry is degenerate or ill-conditioned.');
}

function cleanZero(value){return value===0?0:value;}

function canonical(value){
  if(!Number.isFinite(value))fail('World-file affine calculation produced a nonfinite result.');
  return cleanZero(Number(cleanZero(value).toPrecision(12)));
}

function format(value){return cleanZero(value).toPrecision(12);}

export function worldFileFromCorners(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('World-file input must be a corner and dimension object.');
  const upperLeft=finitePair(input.upperLeft,'Upper-left');
  const upperRight=finitePair(input.upperRight,'Upper-right');
  const lowerLeft=finitePair(input.lowerLeft,'Lower-left');
  const pixelWidth=positiveDimension(input.pixelWidth,'Pixel width');
  const pixelHeight=positiveDimension(input.pixelHeight,'Pixel height');
  const A=(upperRight[0]-upperLeft[0])/pixelWidth;
  const D=(upperRight[1]-upperLeft[1])/pixelWidth;
  const B=(lowerLeft[0]-upperLeft[0])/pixelHeight;
  const E=(lowerLeft[1]-upperLeft[1])/pixelHeight;
  const raw=[A,D,B,E,upperLeft[0]+(A+B)/2,upperLeft[1]+(D+E)/2];
  if(raw.some(value=>!Number.isFinite(value)))fail('World-file affine calculation produced a nonfinite result.');
  validateAffine(raw);
  const coefficients=Object.freeze(raw.map(canonical));
  validateAffine(coefficients);
  const text=coefficients.map(format).join('\n')+'\n';
  return Object.freeze({coefficients,text});
}

export function pixelToGround(pixel,coefficients){
  if(!Array.isArray(pixel)||pixel.length!==2||pixel.some(coordinate=>typeof coordinate!=='number'||!Number.isFinite(coordinate)))fail('Pixel coordinate must be an exact pair of finite numbers.');
  finiteCoefficients(coefficients);validateAffine(coefficients);
  const [column,row]=pixel,[A,D,B,E,C,F]=coefficients;
  const result=[A*column+B*row+C,D*column+E*row+F].map(cleanZero);
  if(result.some(value=>!Number.isFinite(value)))fail('Pixel-to-ground result must remain finite.');
  return result;
}

export function worldFileExtension(imageExtension){
  if(typeof imageExtension!=='string'||!Object.hasOwn(EXTENSIONS,imageExtension))fail('Image extension must be exactly png, jpg, jpeg, tif, or tiff for a PNG, JPEG, or TIFF world file.');
  return EXTENSIONS[imageExtension];
}
