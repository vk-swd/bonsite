import React, { Children, useRef, useState } from "react";
import { last } from "../common/utils";
import { renderMenuButton } from "./SuperButton";
import Select, { InputActionMeta, components } from 'react-select'
import { logger } from "../logger";



type DebounceParams<T> = {
    timer?: NodeJS.Timeout,
    lastValue: string,
    isLookingUp: boolean,
    scheduled?: { val: string, item?: T }
    menuItems?: { top: T, bot: T }
}

export function getUserSelectItem<UserOption>(
    fetchUsers: (val: string, item?: UserOption) => Promise<UserOption[]>,
    onUserSelected: (user: UserOption | null) => void,
    showUserListButtons: boolean = true, minHeight: number = 56, init = false) {

    const [optionsUserNames, setFoundUserData] = useState<UserOption[]>([]);
    const [selectedUserForStatement, setSelectedUserForStatement] = useState<UserOption[]>([]);
    const refreshOptionsTop = () => {
        userPatternDebounceState.current.scheduled = {
            val: userPatternDebounceState.current.lastValue,
            item: userPatternDebounceState.current.menuItems?.top // top displayed value
        };
        requestUserList();
    };
    const refreshOptionsBot = () => {
        userPatternDebounceState.current.scheduled = {
            val: userPatternDebounceState.current.lastValue,
            item: userPatternDebounceState.current.menuItems?.bot // top displayed value
        };
        requestUserList();
    };
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const scrollPos = useRef(0);
    const scrollHandler = useRef<(e: Event) => void>((e: Event) => {
        scrollPos.current = (e.target as HTMLDivElement).scrollTop;
    });
    function MenuList(props: any) {
        const children = Children.toArray(props.children);
        const selected = {
            top: Object(children[0])?.props?.data,
            bot: Object(last(children))?.props?.data
        };
        if (selected.top !== undefined && selected.bot !== undefined) {
            userPatternDebounceState.current.menuItems = selected;
        }
        return (
            <components.MenuList {...props}
                innerRef={(ref: HTMLDivElement) => {
                    if (ref) {
                        scrollRef.current?.removeEventListener('scroll', scrollHandler.current);
                        scrollRef.current = ref;
                        ref.addEventListener('scroll', scrollHandler.current);
                        ref.scrollTop = scrollPos.current;
                    }
                }}
            >
                {renderMenuButton("↑", showUserListButtons, refreshOptionsTop)}
                {props.children} {/* regular options */}
                {renderMenuButton("↓", showUserListButtons, refreshOptionsBot)}
            </components.MenuList>)
    };



    const userPatternDebounceState = useRef<DebounceParams<UserOption>>({
        lastValue: "", isLookingUp: false
    });


    const [isLockedForUserRetrieval, lockUserRetrieval] = useState(false);
    const defUseStat = useRef<() => string>(() => {
        return "";
    });
    const [lastInput, setLastInput] = useState(defUseStat.current());

    const DEBOUNCE_INTERVAL_MS = 800;
    if (init) {
        // Initial fetch with empty pattern
        userPatternDebounceState.current.scheduled = { val: "" };
        requestUserList();
    }
    async function handleInputChange(newValue: string, actionMeta: InputActionMeta) {
        if (actionMeta.action === 'input-blur'
            || actionMeta.action === 'menu-close'
            || actionMeta.action === 'set-value'
            || newValue == actionMeta.prevInputValue) {
            return;
        }
        userPatternDebounceState.current.lastValue = newValue;
        setLastInput(newValue);
        debounce();
    }
    function debounce() {
        clearTimeout(userPatternDebounceState.current.timer);
        userPatternDebounceState.current.timer = setTimeout(() => {
            userPatternDebounceState.current.scheduled = { val: userPatternDebounceState.current.lastValue };
            requestUserList();
        }, DEBOUNCE_INTERVAL_MS);
    }
    async function requestUserList() {
        if (userPatternDebounceState.current.isLookingUp ||
            userPatternDebounceState.current.scheduled === undefined) {
            return;
        }
        lockUserRetrieval(true);
        userPatternDebounceState.current.isLookingUp = true;
        const userRetriever = (debounceState: any): Promise<void> => {
            if (!debounceState.current.scheduled) {
                return Promise.resolve();
            }
            const params = debounceState.current.scheduled;
            debounceState.current.scheduled = undefined;
            logger.info(`Requesting user list for pattern`, params.val, params.item);
            return fetchUsers(params.val, params.item)
            .then(res => {
                setFoundUserData(res);
                return userRetriever(debounceState);
            });
        }
        userRetriever(userPatternDebounceState)
        .catch(err => {
            logger.error("Error fetching user list: ", err);
        })
        .finally(() => {
            lockUserRetrieval(false);
            userPatternDebounceState.current.isLookingUp = false;
        });
    }
    function handleUserSelect(users: UserOption[]) {
        setSelectedUserForStatement(users);
        onUserSelected(users.length === 0 ? null : last(users)!);
    }
    return <Select
        value={selectedUserForStatement}
        inputValue={lastInput}
        placeholder="Select User"
        isMulti={true} // see onChange for explanation
        options={optionsUserNames}
        onInputChange={handleInputChange}
        closeMenuOnSelect={false}
        onChange={(newValue, actionMeta) => {
            // Using isMulti={true} and taking only last item is a hack to keep
            // the input text in the input field after the menu is closed in any way.
            // Doing it with single selection hides the selected value on the second
            // manual menu close
            // Reproduction with isMulti={false}:
            // 1) Type some input
            // 2) Select item with input text still there
            // 3) close-open-close the menu with mouse click
            // Now any text is gone amd only "x" mark remains.
            if (newValue.length > 1) {
                newValue = newValue.slice(newValue.length - 1);
            }
            handleUserSelect(newValue as UserOption[]);
        }}
        styles={{
            control: (base: any) => ({
                ...base,
                minHeight
            })
        }}
        isLoading={isLockedForUserRetrieval}
        components={{ MenuList }}
    />
}