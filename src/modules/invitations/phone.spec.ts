/// <reference types="jest" />
import { maskPhone, normalizePhone } from './phone';

describe('Teléfonos', () => {
  it.each([
    ['6123-4567', '+50761234567'],
    ['+507 6123 4567', '+50761234567'],
    ['(507) 6123-4567', '+50761234567'],
    ['00 57 300 1234567', '+573001234567'],
    ['573001234567', '+573001234567'],
  ])('%s → %s', (input, out) => {
    expect(normalizePhone(input, '507')).toBe(out);
  });

  it.each(['', '123', 'abc', '+0 123 456 789'])('rechaza "%s"', (input) => {
    expect(normalizePhone(input, '507')).toBeNull();
  });

  it('enmascara el teléfono para registros y pantallas', () => {
    expect(maskPhone('+50761234567')).toBe('+507 ****4567');
    expect(maskPhone('+573001234567')).toBe('+573 ****4567');
  });
});
