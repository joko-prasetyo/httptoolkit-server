import * as FridaJs from 'frida-js';
import { CustomError } from '@httptoolkit/util';

import { getReachableInterfaces } from '../../util/network';
import { buildIpTestScript } from './frida-scripts';
import { withTimeout } from '../../util/promise';

/**
 * Terminology:
 * - FridaHost: a device which may contain 1+ Frida targets
 * - FridaTarget: a single app that can be intercepted
 **/

export interface FridaHost {
    id: string;
    name: string;
    type: string;
    state:
        | 'unavailable' // Probably not Frida compatible (e.g. not rooted)
        | 'setup-required' // Probably compatible but Frida not installed
        | 'launch-required' // Frida installed, should work if launched
        | 'available', // Frida seems to be running & ready right now
    targets?: FridaTarget[]
}

export interface FridaTarget {
    id: string;
    name: string;
}

export const FRIDA_VERSION = '16.1.7';

export const FRIDA_DEFAULT_PORT = 27042;
export const FRIDA_ALTERNATE_PORT = 24072; // Reversed to mildly inconvenience detection

export const FRIDA_BINARY_NAME = `adirf-server`; // Reversed to mildly inconvenience detection

class FridaScriptError extends CustomError {
    constructor(
        message: FridaJs.ScriptAgentErrorMessage
    ) {
        super(message.description);
        if (message.stack) {
            this.stack = message.stack;
        }
    }
}

class FridaProxyError extends CustomError {
    constructor(message: string, options: { cause?: Error } = {}) {
        super(message, {
            cause: options.cause,
            code: 'unreachable-proxy'
        });
    }
}

export async function testAndSelectProxyAddress(
    session: FridaJs.FridaAgentSession,
    proxyPort: number,
    options: { extraAddresses?: string[] } = {}
): Promise<string> {
    const interfaceAddresses = getReachableInterfaces();
    const ips = interfaceAddresses.map(a => a.address);

    if (options.extraAddresses?.length) {
        ips.push(...options.extraAddresses);
    }

    if (ips.length === 0) {
        throw new FridaProxyError("No local IPs detected for proxy connection");
    }

    const ipTestScript = await buildIpTestScript(ips, proxyPort);

    return await withTimeout(2000, new Promise<string>(async (resolve, reject) => {
        try {
            session.onMessage((message) => {
                if (message.type === 'send') {
                    if (message.payload.type === 'connected') {
                        resolve(message.payload.ip as string);
                    } else if (message.payload.type === 'connection-failed') {
                        reject(new Error(`Could not connect to proxy on port ${proxyPort} at ${
                            ips.length > 1
                            ? `any of: ${ips.join(', ')}`
                            : ips[0]
                        }`));
                    } else {
                        reject(new Error(`Unexpected message type: ${message.payload.type}`));
                    }
                } else if (message.type === 'error') {
                    const fridaError = new FridaScriptError(message);
                    reject(new CustomError(
                        `Error in Frida IP test script: ${message.description}`,
                        { cause: fridaError, code: 'frida-ip-test-script-error' }
                    ));
                }
            });

            await (await session.createScript(ipTestScript)).loadScript();
        } catch (e) {
            reject(e);
        }
    })).catch((e) => {
        throw new FridaProxyError("No proxy IPs were reachable from the target", { cause: e });
    });
}

/**
 * Launch a script, watching for errors during its initial exception, and logging any
 * output or returned messages from the session to the console.
 *
 * Note that only one session monitor can be active at any time, so this will replace
 * any existing session message monitoring.
 */
export async function launchScript(targetName: string, session: FridaJs.FridaAgentSession, script: string) {
    const scriptSession = await session.createScript(script);

    let scriptLoaded = false;
    await new Promise((resolve, reject) => {
        session.onMessage((message) => {
            if (message.type === 'error') {
                const fridaError = new FridaScriptError(message);

                if (!scriptLoaded) {
                    reject(new CustomError(
                        `Failed to run Frida script on ${targetName}: ${message.description}`,
                        { cause: fridaError, code: 'frida-script-error' }
                    ));
                } else {
                    console.warn(`Frida ${targetName} injection error:`, fridaError);
                }
            } else if (message.type === 'log') {
                if (message.payload.trim() === '') return;
                console.log(`Frida ${targetName} [${message.level}]: ${message.payload}`);
            } else {
                console.log(message);
            }
        });

        scriptSession.loadScript()
            .then(resolve)
            .catch(reject);
    });

    scriptLoaded = true;
}