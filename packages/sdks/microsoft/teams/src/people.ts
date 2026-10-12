import type { Fields } from './fields.ts';
import type { TeamsPerson } from './teams-client.ts';

// A person or bot the client has looked up, as the directory described them.
export function readPerson(profile: Fields): TeamsPerson {
  return {
    mri: profile.requiredString('mri'),
    objectId: profile.string('objectId'),
    type: profile.string('type'),
    displayName: profile.string('displayName'),
    givenName: profile.string('givenName'),
    surname: profile.string('surname'),
    email: profile.string('email') ?? profile.string('mail'),
    userPrincipalName: profile.string('userPrincipalName'),
    jobTitle: profile.string('jobTitle'),
    department: profile.string('department'),
    companyName: profile.string('companyName'),
    officeLocation: profile.string('physicalDeliveryOfficeName'),
    userLocation: profile.string('userLocation'),
    tenantName: profile.string('tenantName'),
    userType: profile.string('userType'),
  };
}
