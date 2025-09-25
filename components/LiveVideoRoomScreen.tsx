import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AppView, LiveVideoRoom, User, VideoParticipantState } from '../types';
import { geminiService } from '../services/geminiService';
import Icon from './Icon';
import { AGORA_APP_ID } from '../constants';
import AgoraRTC from 'agora-rtc-sdk-ng';
import type { IAgoraRTCClient, IAgoraRTCRemoteUser, IMicrophoneAudioTrack, ICameraVideoTrack } from 'agora-rtc-sdk-ng';
import { firebaseService } from '../services/firebaseService';

interface LiveVideoRoomScreenProps {
  currentUser: User;
  roomId: string;
  onGoBack: () => void;
  onSetTtsMessage: (message: string) => void;
}

function stringToIntegerHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; 
  }
  return Math.abs(hash);
}

const ParticipantVideo: React.FC<{
    participant: VideoParticipantState;
    videoTrack?: ICameraVideoTrack;
    isLocal?: boolean;
}> = ({ participant, videoTrack, isLocal }) => {
    const videoRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (videoRef.current && videoTrack && videoTrack.enabled) {
            videoTrack.play(videoRef.current);
        }
        return () => {
            // Only stop tracks if they are still playing to avoid errors
            if (videoTrack?.isPlaying) {
                 videoTrack?.stop();
            }
        };
    }, [videoTrack]);

    const showAvatar = participant.isCameraOff || !videoTrack;

    return (
        <div className="relative w-full h-full bg-slate-800 rounded-lg overflow-hidden flex items-center justify-center">
            <div ref={videoRef} className={`w-full h-full ${isLocal ? 'transform scale-x-[-1]' : ''} ${showAvatar ? 'hidden' : ''}`} />
            {showAvatar && (
                <div className="flex flex-col items-center">
                    <img src={participant.avatarUrl} alt={participant.name} className="w-24 h-24 rounded-full object-cover" />
                </div>
            )}
            <div className="absolute bottom-2 left-2 bg-black/50 text-white text-sm px-2 py-1 rounded-md flex items-center gap-2">
                <span>{participant.name}</span>
                {participant.isMuted && <Icon name="microphone-slash" className="w-4 h-4 text-red-400" />}
            </div>
        </div>
    );
};


const LiveVideoRoomScreen: React.FC<LiveVideoRoomScreenProps> = ({ currentUser, roomId, onGoBack, onSetTtsMessage }) => {
    const [room, setRoom] = useState<LiveVideoRoom | null>(null);
    const [participants, setParticipants] = useState<VideoParticipantState[]>([]);
    const [remoteUsers, setRemoteUsers] = useState<IAgoraRTCRemoteUser[]>([]);

    const agoraClient = useRef<IAgoraRTCClient | null>(null);
    const localAudioTrack = useRef<IMicrophoneAudioTrack | null>(null);
    const localVideoTrack = useRef<ICameraVideoTrack | null>(null);
    
    const [isMuted, setIsMuted] = useState(false);
    const [isCameraOff, setIsCameraOff] = useState(false);

    const onGoBackRef = useRef(onGoBack);
    useEffect(() => { onGoBackRef.current = onGoBack; }, [onGoBack]);
    
    useEffect(() => {
        const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
        agoraClient.current = client;
        let tracksPublished = false;

        const setupAgora = async () => {
            client.on('user-published', async (user, mediaType) => {
                await client.subscribe(user, mediaType);
                setRemoteUsers(prev => [...prev.filter(u => u.uid !== user.uid), user]);
            });

            client.on('user-left', (user) => {
                setRemoteUsers(prev => prev.filter(u => u.uid !== user.uid));
            });

            const uid = stringToIntegerHash(currentUser.id);
            const token = await geminiService.getAgoraToken(roomId, uid);
            if (!token) {
                onSetTtsMessage("Failed to connect to the room.");
                onGoBackRef.current();
                return;
            }

            await client.join(AGORA_APP_ID, roomId, token, uid);
            
            try {
                const [audioTrack, videoTrack] = await AgoraRTC.createMicrophoneAndCameraTracks();
                localAudioTrack.current = audioTrack;
                localVideoTrack.current = videoTrack;
                await client.publish([audioTrack, videoTrack]);
                tracksPublished = true;
            } catch (error: any) {
                console.error("Failed to get media devices:", error);
                 if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                    onSetTtsMessage("No camera/microphone found.");
                    // Still join, but with camera/mic off state
                    setIsCameraOff(true);
                    setIsMuted(true);
                    await geminiService.updateParticipantStateInVideoRoom(roomId, currentUser.id, { isCameraOff: true, isMuted: true });
                } else {
                    onSetTtsMessage("Could not access camera/microphone.");
                    onGoBackRef.current();
                    return;
                }
            }
        };

        geminiService.joinLiveVideoRoom(currentUser.id, roomId).then(setupAgora);

        return () => {
            localAudioTrack.current?.stop();
            localAudioTrack.current?.close();
            localVideoTrack.current?.stop();
            localVideoTrack.current?.close();
            client.leave();
            geminiService.leaveLiveVideoRoom(currentUser.id, roomId);
        };
    }, [roomId, currentUser.id, onSetTtsMessage]);

    useEffect(() => {
        const unsubscribe = firebaseService.listenToVideoRoom(roomId, (liveRoom) => {
            if (liveRoom) {
                setRoom(liveRoom);
                setParticipants(liveRoom.participants || []);
            } else {
                onSetTtsMessage("The video room has ended.");
                onGoBackRef.current();
            }
        });
        return unsubscribe;
    }, [roomId, onSetTtsMessage]);

    const toggleMute = async () => {
        if (!localAudioTrack.current) return;
        const muted = !isMuted;
        await localAudioTrack.current.setMuted(muted);
        setIsMuted(muted);
        await geminiService.updateParticipantStateInVideoRoom(roomId, currentUser.id, { isMuted: muted });
    };

    const toggleCamera = async () => {
        if (!localVideoTrack.current) return;
        const cameraOff = !isCameraOff;
        await localVideoTrack.current.setEnabled(!cameraOff);
        setIsCameraOff(cameraOff);
        await geminiService.updateParticipantStateInVideoRoom(roomId, currentUser.id, { isCameraOff: cameraOff });
    };

    const handleEndCall = () => {
        const isHost = room?.host.id === currentUser.id;
        if (isHost) {
            // In a real app, you might want to end the room for everyone
        }
        onGoBack();
    };

    const localParticipantState = participants.find(p => p.id === currentUser.id);

    return (
        <div className="h-full w-full flex flex-col bg-slate-900 text-white">
            <header className="p-4 flex justify-between items-center flex-shrink-0">
                <h1 className="text-xl font-bold truncate">{room?.topic || 'Video Room'}</h1>
            </header>

            <main className="flex-grow grid grid-cols-2 grid-rows-2 gap-2 p-2">
                {localParticipantState && (
                    <ParticipantVideo
                        participant={localParticipantState}
                        videoTrack={localVideoTrack.current || undefined}
                        isLocal
                    />
                )}
                {remoteUsers.map(user => {
                    const participantState = participants.find(p => stringToIntegerHash(p.id) === user.uid);
                    return participantState ? (
                        <ParticipantVideo
                            key={user.uid}
                            participant={participantState}
                            videoTrack={user.videoTrack}
                        />
                    ) : null;
                })}
            </main>

            <footer className="p-4 flex justify-center items-center gap-6 bg-black/30 flex-shrink-0">
                <button onClick={toggleMute} className={`p-4 rounded-full ${isMuted ? 'bg-rose-600' : 'bg-slate-700'}`}>
                    <Icon name={isMuted ? 'microphone-slash' : 'mic'} className="w-6 h-6"/>
                </button>
                <button onClick={toggleCamera} className={`p-4 rounded-full ${isCameraOff ? 'bg-rose-600' : 'bg-slate-700'}`}>
                    <Icon name={isCameraOff ? 'video-camera-slash' : 'video-camera'} className="w-6 h-6"/>
                </button>
                <button onClick={handleEndCall} className="p-4 rounded-full bg-red-600">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" transform="rotate(-135 12 12)"/></svg>
                </button>
            </footer>
        </div>
    );
};

export default LiveVideoRoomScreen;