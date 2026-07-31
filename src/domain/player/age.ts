/**
 * Age derivation.
 *
 * Spec 2.2: "`is_minor` is derived automatically from date of birth — never
 * entered manually. It drives the consent requirement."
 *
 * This is the only place in the codebase permitted to decide whether someone is
 * a minor. API handlers strip any client-supplied `isMinor` and call this.
 *
 * Pure module: no I/O.
 */

/** India's DPDP Act defines a child as a person under eighteen. */
export const MAJORITY_AGE_YEARS = 18;

export function ageInYearsOn(dateOfBirth: Date, on: Date = new Date()): number {
  let age = on.getUTCFullYear() - dateOfBirth.getUTCFullYear();

  const monthDelta = on.getUTCMonth() - dateOfBirth.getUTCMonth();
  const dayDelta = on.getUTCDate() - dateOfBirth.getUTCDate();

  // Birthday has not landed yet this year.
  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
    age -= 1;
  }

  return age;
}

export function deriveIsMinor(dateOfBirth: Date, on: Date = new Date()): boolean {
  return ageInYearsOn(dateOfBirth, on) < MAJORITY_AGE_YEARS;
}

/** The instant a player stops being a minor — used to schedule consent expiry. */
export function majorityDate(dateOfBirth: Date): Date {
  const date = new Date(dateOfBirth);
  date.setUTCFullYear(date.getUTCFullYear() + MAJORITY_AGE_YEARS);
  return date;
}

export interface DateOfBirthValidation {
  ok: boolean;
  problem?: string;
}

/**
 * A DOB that is in the future, or implies an implausible age, is a data-entry
 * error rather than a real person — and a future DOB would wrongly mark an
 * adult as a minor.
 */
export function validateDateOfBirth(dateOfBirth: Date, on: Date = new Date()): DateOfBirthValidation {
  if (Number.isNaN(dateOfBirth.getTime())) {
    return { ok: false, problem: 'Enter a valid date of birth.' };
  }
  if (dateOfBirth.getTime() > on.getTime()) {
    return { ok: false, problem: 'Date of birth cannot be in the future.' };
  }

  const age = ageInYearsOn(dateOfBirth, on);
  if (age > 100) {
    return { ok: false, problem: 'Check the date of birth — that implies an age over 100.' };
  }
  if (age < 3) {
    return { ok: false, problem: 'Players must be at least 3 years old.' };
  }

  return { ok: true };
}

/**
 * Age band matching for the catalog filter and for enrollment checks. Inclusive
 * at both ends, which is how clubs describe them ("U-12" means 12 is fine).
 */
export function fitsAgeBand(age: number, minAge: number, maxAge: number, toleranceYears = 0): boolean {
  return age >= minAge - toleranceYears && age <= maxAge + toleranceYears;
}
