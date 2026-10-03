import { handleContactRequest, type ContactEnvironment } from '../_lib/contact-delivery';

export interface ContactRequestContext {
  request: Request;
  env: ContactEnvironment;
}

export async function onRequest(context: ContactRequestContext): Promise<Response> {
  return handleContactRequest(context.request, context.env);
}
