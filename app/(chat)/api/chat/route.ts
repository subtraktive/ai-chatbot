import {
  type Message,
  createDataStreamResponse,
  smoothStream,
  streamText,
  tool,
  experimental_generateImage
} from 'ai';
import { z } from 'zod';

import { auth } from '@/app/(auth)/auth';
import { myProvider } from '@/lib/ai/models';
import { systemPrompt } from '@/lib/ai/prompts';
import {
  deleteChatById,
  getChatById,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import {
  generateUUID,
  getMostRecentUserMessage,
  sanitizeResponseMessages,
} from '@/lib/utils';

import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';

export const maxDuration = 60;

export async function POST(request: Request) {
  const {
    id,
    messages,
    selectedChatModel,
  }: { id: string; messages: Array<Message>; selectedChatModel: string } =
    await request.json();

  const session = await auth();

  if (!session || !session.user || !session.user.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userMessage = getMostRecentUserMessage(messages);

  if (!userMessage) {
    return new Response('No user message found', { status: 400 });
  }

  const chat = await getChatById({ id });

  if (!chat) {
    const title = await generateTitleFromUserMessage({ message: userMessage });
    await saveChat({ id, userId: session.user.id, title });
  }

  await saveMessages({
    messages: [{ ...userMessage, createdAt: new Date(), chatId: id }],
  });

  const formattedMessages = messages.map(m => {
    if (m.role === 'assistant' && m.toolInvocations) {
      m.toolInvocations.forEach(ti => {
        if (ti.toolName === 'generateImage' && ti.state === 'result') {
          ti.result.image = `redacted-for-length`;
        }
      });
    }
    return m;
  });

  return createDataStreamResponse({
    execute: (dataStream) => {
      const result = streamText({
        model: myProvider.languageModel(selectedChatModel),
        system: systemPrompt({ selectedChatModel }),
        messages: formattedMessages,
        maxSteps: 5,
        experimental_activeTools:
          selectedChatModel === 'chat-model-reasoning'
            ? []
            : [
                'getWeather',
                'createDocument',
                'updateDocument',
                'requestSuggestions',
                'generateImageModel1',
                // 'generateImageModel2'
              ],
        experimental_transform: smoothStream({ chunking: 'word' }),
        experimental_generateMessageId: generateUUID,
        tools: {
          getWeather,
          createDocument: createDocument({ session, dataStream }),
          updateDocument: updateDocument({ session, dataStream }),
          requestSuggestions: requestSuggestions({
            session,
            dataStream,
          }),
          generateImageModel1: tool({
            description: 'Generate an image',
            parameters: z.object({
              prompt: z.string().describe('The prompt to generate the image from'),
            }),
            execute: async ({ prompt }) => {
              
              let startTime = performance.now();

              let smalModelEndStamp;
              let largeModelEndStamp;
              console.log("CALLING MODEL 1")
              const smallModelImg = experimental_generateImage({
                model: myProvider.imageModel('small-model'),
                prompt,
                size: '1024x1024',
              }).then((data) => {
                let {image} = data;
                smalModelEndStamp = `${((performance.now() - startTime)/1000).toFixed(1)}s`;
                console.log("FINISHED 1")
                return { image: image.base64, prompt, time: smalModelEndStamp, model: 'small-model' };
              });
              
              console.log("CALLING MODEL 1")
              const largeModelImg = experimental_generateImage({
                model: myProvider.imageModel('large-model'),
                prompt,
                size: '1024x1024',
              }).then(({image}) => {
                largeModelEndStamp = `${((performance.now() - startTime)/1000).toFixed(1)}s`;
                console.log("FINISHED 2")
                return { image: image.base64, prompt, time: largeModelEndStamp, model: 'large-model' };
              });
              
              try {
               let result = await Promise.all([smallModelImg, largeModelImg]).then((final) => final)
               console.log("FINAL RESULT_+_________", result)
               return result
              } catch(e) {
                return []
              }


              try {
                const { image } = await experimental_generateImage({
                  model: myProvider.imageModel('small-model'),
                  prompt,
                  size: '1024x1024',
                });
                const endTime = performance.now();
                let timeToGenerate = ((endTime - startTime)/1000).toFixed(1)
                console.log("DONE CALLING MODEL 1*********************")
                //in production, save this image to blob storage and return a URL
                return { image: image.base64, prompt, time: timeToGenerate, model: 'small-model' };
              } catch (e) {
                console.log("WHAT IS THE ERROR in model 1 ", e)
                return { image: '', prompt, time: 0, model: 'small-model', error: e };
              }


            },
          }),
          generateImageModel2: tool({
            description: 'Generate an image with second model',
            parameters: z.object({
              prompt: z.string().describe('The prompt to generate the image from'),
            }),
            execute: async ({ prompt }) => {
              console.log("CALLING MODEL 2")
              let startTime = performance.now();
              try {
                const { image } = await experimental_generateImage({
                  model: myProvider.imageModel('large-model'),
                  prompt,
                  size: '1024x1024',
                });
                const endTime = performance.now();
                let timeToGenerate = ((endTime - startTime)/1000).toFixed(1)
                //in production, save this image to blob storage and return a URL
                console.log("DONE CALLING MODEL 2*********************")
                return { image: image.base64, prompt, time: timeToGenerate, model: 'large-model' };
              } catch(e) {
                console.log("WHAT IS THE ERROR in model 2 ", e)
                return { image: '', prompt, time: 0, model: 'small-model', error: e };
              }
            },
          })
        },
        onFinish: async ({ response, reasoning }) => {
          if (session.user?.id) {
            try {
              const sanitizedResponseMessages = sanitizeResponseMessages({
                messages: response.messages,
                reasoning,
              });

              await saveMessages({
                messages: sanitizedResponseMessages.map((message) => {
                  return {
                    id: message.id,
                    chatId: id,
                    role: message.role,
                    content: message.content,
                    createdAt: new Date(),
                  };
                }),
              });
            } catch (error) {
              console.error('Failed to save chat');
            }
          }
        },
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'stream-text',
        },
      });

      result.mergeIntoDataStream(dataStream, {
        sendReasoning: true,
      });
    },
    onError: () => {
      return 'Oops, an error occured!';
    },
  });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  const session = await auth();

  if (!session || !session.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const chat = await getChatById({ id });

    if (chat.userId !== session.user.id) {
      return new Response('Unauthorized', { status: 401 });
    }

    await deleteChatById({ id });

    return new Response('Chat deleted', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request', {
      status: 500,
    });
  }
}
