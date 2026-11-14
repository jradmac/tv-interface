import AppIntents
import SwiftUI
import WidgetKit

@main
struct TVRemoteWidgetBundle: WidgetBundle {
    var body: some Widget {
        TVButtonsWidget()
        TalkControl()
        PlayPauseControl()
        PowerControl()
        VolumeUpControl()
        VolumeDownControl()
    }
}

// MARK: - Control Center (and the Lock Screen's bottom corners, and the Action button)

struct TalkControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredmackay.tvremote.talk") {
            ControlWidgetButton(action: TalkToTVIntent()) {
                Label("Talk to TV", systemImage: "mic.fill")
            }
        }
        .displayName("Talk to TV")
        .description("Opens the remote, listening.")
    }
}

struct PlayPauseControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredmackay.tvremote.playpause") {
            ControlWidgetButton(action: PlayPauseTVIntent()) {
                Label("TV Play/Pause", systemImage: "playpause.fill")
            }
        }
        .displayName("TV Play/Pause")
    }
}

struct PowerControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredmackay.tvremote.power") {
            ControlWidgetButton(action: PowerTVIntent()) {
                Label("TV power", systemImage: "power")
            }
        }
        .displayName("TV power")
        .description("Turns the TV on or off.")
    }
}

struct VolumeUpControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredmackay.tvremote.volup") {
            ControlWidgetButton(action: VolumeUpTVIntent()) {
                Label("TV Volume Up", systemImage: "speaker.plus.fill")
            }
        }
        .displayName("TV Volume Up")
    }
}

struct VolumeDownControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jaredmackay.tvremote.voldown") {
            ControlWidgetButton(action: VolumeDownTVIntent()) {
                Label("TV Volume Down", systemImage: "speaker.minus.fill")
            }
        }
        .displayName("TV Volume Down")
    }
}

// MARK: - Lock Screen and Home Screen widget: play/pause, volume, talk

struct ButtonsEntry: TimelineEntry { let date: Date }

struct ButtonsProvider: TimelineProvider {
    func placeholder(in context: Context) -> ButtonsEntry { ButtonsEntry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (ButtonsEntry) -> Void) { completion(ButtonsEntry(date: .now)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ButtonsEntry>) -> Void) {
        completion(Timeline(entries: [ButtonsEntry(date: .now)], policy: .never))
    }
}

struct TVButtonsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.jaredmackay.tvremote.buttons", provider: ButtonsProvider()) { _ in
            ButtonsView()
        }
        .configurationDisplayName("TV Remote")
        .description("Play/pause, volume and talk to the TV.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .systemSmall])
    }
}

private let room = Color(red: 0xF3 / 255, green: 0xF1 / 255, blue: 0xEC / 255)
private let ink = Color(red: 0x1C / 255, green: 0x1B / 255, blue: 0x19 / 255)

struct ButtonsView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            Button(intent: TalkToTVIntent()) {
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: "mic.fill").font(.system(size: 22, weight: .semibold))
                }
            }
            .buttonStyle(.plain)
            .widgetAccentable()
            .containerBackground(.clear, for: .widget)
        case .accessoryRectangular:
            HStack(spacing: 6) {
                small(PlayPauseTVIntent(), "playpause.fill")
                small(VolumeDownTVIntent(), "speaker.minus.fill")
                small(VolumeUpTVIntent(), "speaker.plus.fill")
                small(TalkToTVIntent(), "mic.fill")
            }
            .containerBackground(.clear, for: .widget)
        default:
            VStack(spacing: 8) {
                HStack {
                    Text("Living room").font(.system(size: 13, weight: .semibold)).foregroundStyle(ink)
                    Spacer()
                }
                HStack(spacing: 8) {
                    big(PlayPauseTVIntent(), "playpause.fill", dark: false)
                    big(TalkToTVIntent(), "mic.fill", dark: true)
                }
                HStack(spacing: 8) {
                    big(VolumeDownTVIntent(), "speaker.minus.fill", dark: false)
                    big(VolumeUpTVIntent(), "speaker.plus.fill", dark: false)
                }
            }
            .containerBackground(room, for: .widget)
        }
    }

    private func small(_ intent: some AppIntent, _ icon: String) -> some View {
        Button(intent: intent) {
            Image(systemName: icon).font(.system(size: 15, weight: .semibold))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(AccessoryWidgetBackground().clipShape(RoundedRectangle(cornerRadius: 8)))
        }
        .buttonStyle(.plain)
        .widgetAccentable()
    }

    private func big(_ intent: some AppIntent, _ icon: String, dark: Bool) -> some View {
        Button(intent: intent) {
            Image(systemName: icon).font(.system(size: 18, weight: .semibold))
                .foregroundStyle(dark ? .white : ink)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(dark ? ink : .white))
        }
        .buttonStyle(.plain)
    }
}
