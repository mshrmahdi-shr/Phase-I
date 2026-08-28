export const ACQUISITION_YEAR_RANGE=Object.freeze({minimum:1850,maximumUtcYearOffset:1});
export const MIN_ACQUISITION_YEAR=ACQUISITION_YEAR_RANGE.minimum;

export function maximumAcquisitionYear(now=new Date()){
  const current=now?.getUTCFullYear?.();
  if(!Number.isSafeInteger(current))throw new Error('The current UTC year is unavailable.');
  return current+ACQUISITION_YEAR_RANGE.maximumUtcYearOffset;
}

export function validateAcquisitionYearRange(value,{label='Acquisition year',allowNull=false,now=new Date()}={}){
  if(allowNull&&value===null)return null;
  const maximum=maximumAcquisitionYear(now);
  if(!Number.isSafeInteger(value)||value<MIN_ACQUISITION_YEAR||value>maximum)throw new Error(`${label} must be a four-digit integer from ${MIN_ACQUISITION_YEAR} through ${maximum}${allowNull?', or left blank when unknown.':'.'}`);
  return value;
}
