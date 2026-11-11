/// <reference types="jest" />
import { calculateHiringFee, RECRUITER_SHARE } from './fee-schedule';

describe('calculateHiringFee (tabla de la presentación CME)', () => {
  it.each([
    [500, 150],
    [1000, 150],
    [1000.01, 250],
    [2500, 250],
    [2501, 375],
    [3500, 375],
    [3501, 500],
    [5000, 500],
  ])('posición de US$%p → fee US$%p', (amount, fee) => {
    expect(calculateHiringFee(amount).fee).toBe(fee);
  });

  it('desde US$5,001 cobra el 12%', () => {
    expect(calculateHiringFee(5001).fee).toBe(600.12);
    expect(calculateHiringFee(10000).fee).toBe(1200);
  });

  it('el reclutador recibe el 10% del fee', () => {
    expect(RECRUITER_SHARE).toBe(0.1);
    expect(calculateHiringFee(2000).recruiterPayout).toBe(25);
    expect(calculateHiringFee(10000).recruiterPayout).toBe(120);
  });

  it('rechaza montos vacíos, cero o negativos', () => {
    expect(() => calculateHiringFee(0)).toThrow();
    expect(() => calculateHiringFee(-10)).toThrow();
    expect(() => calculateHiringFee(Number.NaN)).toThrow();
  });
});
