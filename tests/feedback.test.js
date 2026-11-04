import test from 'node:test';import assert from 'node:assert/strict';
import {elapsedLabel,failureHelp} from '../src/feedback.js';
import demo from '../src/demo/weather-project.json' with {type:'json'};
import {analyze} from '../src/parser.js';import {validateStory} from '../src/server/ai.js';
test('elapsed time and failure guidance distinguish setup, context, authentication and bad output',()=>{assert.equal(elapsedLabel(0),'0:00');assert.equal(elapsedLabel(65000),'1:05');assert.match(failureHelp({code:'local_context_limit'}).action,/smaller file/);assert.match(failureHelp({code:'runner_not_installed'}).action,/Install Ollama/);assert.match(failureHelp({code:'local_auth_required'}).action,/authentication/);assert.match(failureHelp({code:'invalid_story'}).action,/validation/);});
test('every bundled demo guide passes the production reference and narrative validation',()=>{assert.equal(demo.files.length,3);for(const file of demo.files){const guide=structuredClone(demo.guides[file.path]);assert.equal(guide.demo,true);assert.ok(validateStory(guide.story,analyze(file.code,file.path)));assert.ok(guide.story.chapters.every(c=>c.beginner&&c.storyBeginner));}});
